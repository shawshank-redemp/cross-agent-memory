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
  // Prompt text for this signal given its computed value, or null when the
  // value is unremarkable and does not belong in the prompt at all. Returning
  // null for inactive signals keeps the policy block to what actually applies
  // to THIS customer rather than a standing lecture about every rule.
  describe(value: TValue): string | null;
  effects(value: TValue): SignalEffects;
}

// The registry constraint. `any` here is load-bearing: it is what lets the
// registry hold definitions with different TValue types while `satisfies`
// still type-checks each entry individually and preserves its literal type
// for the MemorySignals derivation.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySignalDefinition = SignalDefinition<any>;
