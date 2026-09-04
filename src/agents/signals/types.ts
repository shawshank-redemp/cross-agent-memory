import type { AgentType, CustomerMemoryProfile } from "../../types/index.js";

// A normalised view of the event that triggered this decision.
//
// Signals that read the TRIGGERING EVENT (rather than memory) need its facts,
// but the signal layer must not learn the shape of three different event
// types — that would put cart/subscription/dispute vocabulary into the policy
// layer and mean a fourth agent could not be added without editing it. Each
// agent module maps its own event into this shape instead.
export interface TriggeringEventFacts {
  agent: AgentType;
  // The event's own timestamp. Also the asOf cutoff the profile was read at,
  // so recency rules and the profile agree on "now" by construction.
  timestamp: string;
  amount: number; // paise
  paymentAttempted: boolean;
  paymentErrorCode: string | null;
}

// How much a customer's dispute history should tighten discounting, ordered
// by severity. customer_adverse outranks everything; a history of nothing but
// merchant-conceded disputes yields "none", because the merchant losing or
// accepting a chargeback is evidence about the merchant's delivery, not about
// the customer's trustworthiness.
//
// The unresolved tier is split three ways by the dispute's REASON. This
// matters because a dispute takes weeks to resolve, so at decision time most
// disputes are unresolved and the reason is the only evidence there is —
// treating "goods never arrived" and "I don't recognise this charge" as the
// same caution throws away the one signal available.
export type DisputeCautionLevel =
  | "none"
  | "unresolved_merchant_fault"
  | "unresolved_neutral"
  | "unresolved_customer_fault"
  | "adverse";

// Everything a signal is allowed to look at.
export interface SignalContext {
  profile: CustomerMemoryProfile;
  agent: AgentType;
  event: TriggeringEventFacts;
}

// What an ACTIVE signal does to the decision. A signal returns an empty object
// when its value is the inactive/default one, which is what lets
// resolveSignalEffects treat "contributed nothing" and "contributed a neutral
// value" as the same thing.
export interface SignalEffects {
  blocksDiscount?: boolean;
  // Stop contacting this customer at all — not "spend less", but "send
  // nothing". The only memory effect that does not run through spend.
  //
  // Every other effect regulates margin, so memory could only ever show up as
  // spending less than the baseline. Measured across six prompt revisions, the
  // model declines to discount a first-touch abandonment under every framing —
  // a defensible position, since a free reminder is real business practice. But
  // it means the discount lever is never pulled, so the caps and blocks pointed
  // at it never fire and memory has nothing to grip.
  //
  // This is not a demo device. It is a standing risk rule: a customer whose
  // chargeback was ruled against them, who has since failed repeatedly across
  // agents, is one you stop marketing to. No single agent can make that call —
  // Cart Abandonment cannot see the ruling, and the Dispute Responder cannot see
  // the abandonment.
  suppressesOutreach?: boolean;
  forcesEscalation?: boolean;
  // Ceiling as a percentage of the triggering event's amount. Resolved by
  // taking the MINIMUM across every active signal — see resolveSignalEffects.
  discountCapPercent?: number;
}

// Whether a signal is true about the PERSON or about one agent's relationship
// with them. This tag is not decorative: it is the contract for adding a
// fourth agent. Customer-scoped signals are inherited unchanged by any new
// agent, because they say nothing about who is asking. Agent-scoped signals
// are computed against the asking agent and are the only ones a new agent has
// to think about.
export type SignalScope = "customer" | "agent";

// What a signal is FOR.
//   brake       — restricts what the agent may do (the historical default;
//                 every signal was one of these before provenPayer).
//   accelerator — widens what the agent may do for a customer who has earned it.
//   router      — changes WHICH intervention fits, without changing limits.
// What a signal DOES, not what it is about.
//
// `context` replaces `router`. Two signals used to be tagged `brake` while
// having no effects at all, which made this field unreliable: it was doing
// double duty as "restricts things" and "is vaguely negative". A signal is now
// either one of the three that change the decision, or honestly labelled as
// informing the model and constraining nothing.
//
// `router` is gone with paymentFriction, the only signal that carried it. It
// promised to change WHICH action fits, but no action existed to route to, so
// it changed nothing. If a retry action is added later, `router` comes back
// with a signal that actually does something.
export type SignalKind = "brake" | "accelerator" | "context";

// One signal, entirely self-contained: how to compute it, how to explain it to
// the model, and what it does to the decision. Generic over the value so a
// boolean signal, a numeric counter, and a string-union level all satisfy the
// same shape.
//
// compute/describe/effects are declared with METHOD syntax on purpose. Method
// parameters are bivariant in TypeScript, which is what allows a
// SignalDefinition<boolean> and a SignalDefinition<DisputeCautionLevel> to
// live in one registry object under a single constraint. Property-syntax
// arrow types would be contravariant under strictFunctionTypes and would not
// unify.
export interface SignalDefinition<TValue> {
  id: string;
  scope: SignalScope;
  kind: SignalKind;
  compute(ctx: SignalContext): TValue;
  // THE MEASUREMENT, always returned, never null.
  //
  // Replaces the old describe(), which returned a full sentence only when the
  // value was "interesting" and null otherwise. That shape caused two problems.
  //
  // It THREW AWAY MAGNITUDE. Seven of nine signals are booleans, so the model
  // was told `true` and nothing else. Measured on the batch,
  // repeatRecoveryWithThisAgent was `true` on 516 decisions covering anywhere
  // from 3 to 7 actual events, and provenPayer was `true` across lifetime spends
  // from ₹2,599 to ₹14,298. A customer who came back three times and one who
  // came back seven got byte-identical input.
  //
  // And it SPLIT ONE CONCEPT ACROSS TWO PLACES. A signal whose describe()
  // returned text went into the system prompt as prose; one that returned null
  // went into the user message as a bare JSON boolean. Which half a signal
  // landed in depended on its value, so the model had to reconcile two formats
  // in two locations for one idea.
  //
  // measure() states the fact WITH its magnitude and threshold, for every signal
  // on every call — "6 cart events in 90 days (limit 3)", "1 payment, ₹450
  // lifetime (needs 2 and ₹2,500)". The "boring" answers become informative
  // rather than a row of `false`.
  //
  // It takes ctx, not just the value, because the magnitude usually lives on the
  // profile rather than in the computed value itself.
  //
  // What policy DOES about it is not written here — it is generated from
  // effects() (see renderSignalEffects), so the stated consequence and the
  // enforced one cannot drift apart.
  measure(ctx: SignalContext, value: TValue): string;
  effects(value: TValue): SignalEffects;
}

// The registry constraint. `any` here is load-bearing: it is what lets the
// registry hold definitions with different TValue types while `satisfies`
// still type-checks each entry individually and preserves its literal type
// for the MemorySignals derivation.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySignalDefinition = SignalDefinition<any>;
