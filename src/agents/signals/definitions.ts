import { disputeFaultForReason } from "../../data/fixtures.js";
import type { AgentType } from "../../types/index.js";
import {
  CHURN_LOOKBACK_DAYS,
  DEFAULT_DISCOUNT_CAP_PERCENT,
  DISCOUNT_CAP_PERCENT_BY_CAUTION_LEVEL,
  CROSS_AGENT_SPEND_FLOOR_PAISE,
  CROSS_AGENT_SPEND_SHARE_OF_LIFETIME_PAID,
  DISCOUNT_HISTORY_LOOKBACK_DAYS,
  INEFFECTIVE_DISCOUNT_MIN_ATTEMPTS,
  MAX_DISCOUNTS_PER_AGENT,
  MIN_LIFETIME_PAID_PAISE,
  MIN_SUCCESSFUL_PAYMENTS,
  PROVEN_PAYER_DISCOUNT_CAP_PERCENT,
  REPEAT_RECOVERY_DISCOUNT_CAP_PERCENT,
  REPEAT_RECOVERY_LOOKBACK_DAYS,
  REPEAT_RECOVERY_THRESHOLD_ACROSS_AGENTS,
  REPEAT_RECOVERY_THRESHOLD_PER_AGENT,
} from "./thresholds.js";
import type { AnySignalDefinition, DisputeCautionLevel, SignalContext, SignalDefinition } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// Most severe wins. Within the unresolved tier the ordering is
// customer > neutral > merchant, so one "I don't recognise this charge" among
// several merchant-fault complaints still tightens the cap.
function computeDisputeCautionLevel(ctx: SignalContext): DisputeCautionLevel {
  if (ctx.profile.dispute_breakdown.customer_adverse > 0) return "adverse";
  const faults = new Set(ctx.profile.unresolved_dispute_reasons.map(disputeFaultForReason));
  if (faults.has("customer")) return "unresolved_customer_fault";
  if (faults.has("neutral")) return "unresolved_neutral";
  if (faults.has("merchant")) return "unresolved_merchant_fault";
  return "none";
}

// Rupees, for the measurements below. Amounts are stored in paise everywhere
// else; a model reading "₹450" understands it faster than "45000 paise".
function rupees(paise: number): string {
  return `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;
}

// What each caution level MEANS, without stating what policy does about it —
// that half is generated from effects() so the stated consequence and the
// enforced one cannot drift.
const DISPUTE_LEVEL_MEANING: Record<DisputeCautionLevel, string> = {
  none: "no dispute counts against this customer",
  unresolved_merchant_fault:
    "an unresolved dispute whose reason points at the MERCHANT (goods not received, service not as described) — not evidence against the customer",
  unresolved_neutral:
    "an unresolved dispute whose reason points at neither side (duplicate charge, subscription not cancelled) — genuine uncertainty rather than established fault",
  unresolved_customer_fault:
    "an unresolved dispute whose reason points at the CUSTOMER (they do not recognise their own transaction) — no ruling yet, but the one unresolved shape carrying real risk",
  adverse:
    "a dispute was RESOLVED AGAINST this customer — the merchant contested it and the complaint did not hold up. A ruling that has actually been made, not an allegation",
};

const disputeCautionLevel: SignalDefinition<DisputeCautionLevel> = {
  id: "disputeCautionLevel",
  scope: "customer",
  kind: "brake",
  compute: computeDisputeCautionLevel,
  measure(ctx, value) {
    const n = ctx.profile.dispute_breakdown;
    const filed = ctx.profile.dispute_count;
    const detail =
      filed === 0
        ? "no disputes on record"
        : `${filed} dispute(s) filed, ${rupees(ctx.profile.total_disputed_amount)} total` +
          ` (${n.unresolved} unresolved, ${n.customer_adverse} decided against them` +
          `${n.customer_adverse > 0 ? ` worth ${rupees(ctx.profile.adverse_disputed_amount)}` : ""})`;
    return `${value} — ${DISPUTE_LEVEL_MEANING[value]}. ${detail}.`;
  },
  effects(value) {
    // `adverse` blocks outright and sets no ceiling — see the cap table in
    // thresholds.ts for why it is deliberately absent from it. It does NOT
    // escalate: a ruled dispute is unambiguous, and a person adds nothing.
    if (value === "adverse") return { blocksDiscount: true };
    const cap = DISCOUNT_CAP_PERCENT_BY_CAUTION_LEVEL[value];
    // A level at or above the standing default is NOT a brake — it contributes
    // no cap at all, so it cannot hold a proven payer back from the wider
    // ceiling. Only levels that actually tighten below the default constrain.
    return cap < DEFAULT_DISCOUNT_CAP_PERCENT ? { discountCapPercent: cap } : {};
  },
};

// ---------------------------------------------------------------------------
// REMOVED: disputeCautionWarranted
//
// It computed `disputeCautionLevel !== "none"` and fired on the identical 393
// events, with no effects and no prompt text — the level signal with its detail
// thrown away, kept only because a dashboard wanted a boolean. A dashboard can
// ask whether the level is "none" itself. It was also tagged `brake` while
// braking nothing, which is what made the `kind` field meaningless.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// REMOVED: paymentFriction
//
// It read `ctx.event`, never memory, so the BASELINE arm saw the identical
// fact — any divergence it produced could never be evidence that cross-agent
// memory helped, which is the one thing this system exists to show.
//
// It was also redundant three times over: the raw event we already send the
// model carries `attempts` and `last_error_code`, so the signal restated a
// field sitting in the same payload; `paymentAttempted` was hardcoded TRUE for
// subscription_recovery, where a failed charge IS a declined payment by
// definition, so it fired on every event and told that agent nothing; and it
// was hardcoded FALSE for dispute_responder, where it never fired at all.
//
// The idea is worth keeping in a form that is actually memory: "this customer's
// payments keep being declined, across carts AND subscription cycles" is a
// genuine cross-agent fact pointing at a different remedy (fix the instrument,
// do not spend margin). That needs decline history in the profile, which is a
// MEMORY change, so it is logged as follow-up rather than smuggled in here.
// ---------------------------------------------------------------------------

// Recovery-flow events in the policy window, optionally for one agent.
//
// Reads the raw asOf-scoped list rather than the profile's precomputed
// count_recent, so the WINDOW belongs to the rule and not to storage: profile.ts
// answers what is true, the registry answers over what period it counts. If the
// two ever diverge, the rule stays correct.
function recoveryEventsInWindow(ctx: SignalContext, agent?: AgentType): number {
  const asOfMs = Date.parse(ctx.event.timestamp);
  const floorMs = asOfMs - REPEAT_RECOVERY_LOOKBACK_DAYS * DAY_MS;
  let n = 0;
  for (const e of ctx.profile.recovery_activity.recent_events) {
    const ts = Date.parse(e.timestamp);
    if (ts <= asOfMs && ts >= floorMs && (agent === undefined || e.agent === agent)) n += 1;
  }
  return n;
}

// Discounts granted in the policy window, optionally by one agent.
function discountsInWindow(ctx: SignalContext, agent?: AgentType) {
  const asOfMs = Date.parse(ctx.event.timestamp);
  const floorMs = asOfMs - DISCOUNT_HISTORY_LOOKBACK_DAYS * DAY_MS;
  return ctx.profile.discount_usage_history.filter((d) => {
    const ts = Date.parse(d.timestamp);
    return ts <= asOfMs && ts >= floorMs && (agent === undefined || d.agent === agent);
  });
}

// How much margin this customer may still absorb across ALL agents. Expressed
// against what they have actually paid us, with a floor so a customer who has
// never paid is not frozen out entirely — see thresholds.ts.
function crossAgentSpendAllowancePaise(ctx: SignalContext): number {
  return Math.max(
    CROSS_AGENT_SPEND_FLOOR_PAISE,
    Math.round(ctx.profile.total_paid_amount * CROSS_AGENT_SPEND_SHARE_OF_LIFETIME_PAID),
  );
}

// CONTEXT, not a brake. It constrains nothing; it tells the model what has
// already been spent here so its reasoning is informed. It was tagged `brake`
// while having no effects, which is precisely what made `kind` unreliable.
const discountsGrantedByThisAgent: SignalDefinition<number> = {
  id: "discountsGrantedByThisAgent",
  scope: "agent",
  kind: "context",
  compute: (ctx) => discountsInWindow(ctx, ctx.agent).length,
  measure: (ctx, value) => {
    const spent = discountsInWindow(ctx, ctx.agent).reduce((sum, d) => sum + d.amount, 0);
    return value === 0
      ? `none — this agent has committed no margin to this customer in the last ${DISCOUNT_HISTORY_LOOKBACK_DAYS} days`
      : `${value} discount(s) worth ${rupees(spent)} in the last ${DISCOUNT_HISTORY_LOOKBACK_DAYS} days`;
  },
  effects: () => ({}),
};

// Counts DISCOUNTS WE GAVE, which is what separates it from the repeat-recovery
// signals below — those count events the customer had. The two used to share one
// threshold constant despite measuring unrelated things.
//
// Blocks spend and does NOT escalate: an agent reaching its own budget is a
// budgeting fact, not something a person needs to adjudicate.
const discountLimitReached: SignalDefinition<boolean> = {
  id: "discountLimitReached",
  scope: "agent",
  kind: "brake",
  compute: (ctx) => discountsInWindow(ctx, ctx.agent).length >= MAX_DISCOUNTS_PER_AGENT,
  measure: (ctx) => {
    const n = discountsInWindow(ctx, ctx.agent).length;
    return `${n} of ${MAX_DISCOUNTS_PER_AGENT} allowed discounts used by this agent in the last ${DISCOUNT_HISTORY_LOOKBACK_DAYS} days`;
  },
  effects: (value) => (value ? { blocksDiscount: true } : {}),
};

// Renamed from `gamingSuspected`, and downgraded from "block and escalate" to a
// tighter ceiling.
//
// The old name accused the customer of farming discounts while the rule only
// counted events they had — so a customer who abandoned three carts and was
// never offered anything was flagged as a discount farmer, blocked, and sent to
// a person. You cannot farm a discount you were never given. Repeatedly failing
// to complete a purchase is a reason for caution, not proof of abuse, and
// caution is a ceiling.
const repeatRecoveryWithThisAgent: SignalDefinition<boolean> = {
  id: "repeatRecoveryWithThisAgent",
  scope: "agent",
  kind: "brake",
  compute: (ctx) => recoveryEventsInWindow(ctx, ctx.agent) >= REPEAT_RECOVERY_THRESHOLD_PER_AGENT,
  measure: (ctx) => {
    const n = recoveryEventsInWindow(ctx, ctx.agent);
    return `${n} event(s) in this agent's recovery flow in the last ${REPEAT_RECOVERY_LOOKBACK_DAYS} days (threshold ${REPEAT_RECOVERY_THRESHOLD_PER_AGENT})`;
  },
  effects: (value) => (value ? { discountCapPercent: REPEAT_RECOVERY_DISCOUNT_CAP_PERCENT } : {}),
};

// The same pattern seen across agents rather than within one, where no single
// agent's count would ever reach its own threshold.
//
// KEPT rather than folded into the spend limit below, deliberately. The two ask
// different questions — how often they came back, versus how much we spent —
// and only this one can fire before any margin has been committed. Deleting it
// would also silently un-test the `cross_agent_gaming` scenario, 6% of the
// batch, which is constructed precisely to reach a cross-agent total while
// every per-agent count stays below its threshold.
const repeatRecoveryAcrossAgents: SignalDefinition<boolean> = {
  id: "repeatRecoveryAcrossAgents",
  scope: "customer",
  kind: "brake",
  compute: (ctx) => recoveryEventsInWindow(ctx) >= REPEAT_RECOVERY_THRESHOLD_ACROSS_AGENTS,
  measure: (ctx) => {
    const total = recoveryEventsInWindow(ctx);
    const perAgent = ctx.profile.recovery_activity.by_agent
      .map((a) => `${a.agent.replace(/_/g, " ")} ${a.count_recent}`)
      .join(", ");
    return (
      `${total} event(s) across all agents in the last ${REPEAT_RECOVERY_LOOKBACK_DAYS} days ` +
      `(threshold ${REPEAT_RECOVERY_THRESHOLD_ACROSS_AGENTS})` +
      (perAgent ? ` — ${perAgent}. No single agent can see this total.` : "")
    );
  },
  effects: (value) => (value ? { discountCapPercent: REPEAT_RECOVERY_DISCOUNT_CAP_PERCENT } : {}),
};

// THE CROSS-AGENT SPEND CEILING, and the hole it closes:
//
// discountLimitReached is per agent, so Cart could grant 2, Subscription 2 and
// Dispute 2 — six discounts to one customer — with no agent reaching its own
// limit of 3 and no signal firing. The signal this replaces
// (`crossAgentGamingSuspected`) sounded like it covered that and did not: it
// counted the customer's EVENTS, never our SPEND.
//
// This is the only signal that reads money committed across every agent, which
// makes it the sharpest expression of the whole thesis: no individual agent can
// compute it, because no individual agent can see the others' spend.
const crossAgentSpendLimitReached: SignalDefinition<boolean> = {
  id: "crossAgentSpendLimitReached",
  scope: "customer",
  kind: "brake",
  compute: (ctx) => {
    const spent = discountsInWindow(ctx).reduce((sum, d) => sum + d.amount, 0);
    return spent > 0 && spent >= crossAgentSpendAllowancePaise(ctx);
  },
  measure: (ctx) => {
    const spent = discountsInWindow(ctx).reduce((sum, d) => sum + d.amount, 0);
    const allowance = crossAgentSpendAllowancePaise(ctx);
    return (
      `${rupees(spent)} of a ${rupees(allowance)} allowance used across ALL agents in the last ` +
      `${DISCOUNT_HISTORY_LOOKBACK_DAYS} days. The allowance is the greater of ${rupees(CROSS_AGENT_SPEND_FLOOR_PAISE)} ` +
      `or ${Math.round(CROSS_AGENT_SPEND_SHARE_OF_LIFETIME_PAID * 100)}% of the ${rupees(ctx.profile.total_paid_amount)} ` +
      `this customer has paid us. No single agent can see this total.`
    );
  },
  effects: (value) => (value ? { blocksDiscount: true } : {}),
};

// THE FEEDBACK LOOP, as policy.
//
// Every other brake asks what the customer did. This one asks what WE did and
// whether it worked: we have discounted this customer at least
// INEFFECTIVE_DISCOUNT_MIN_ATTEMPTS times and not one of those discounts
// converted. Continuing to spend against that record is the clearest waste this
// system can identify.
//
// Customer-scoped on purpose. If discounts do not move this customer, that is
// true of the person, not of one agent's relationship with them, so Subscription
// Recovery should inherit what Cart Abandonment learned.
const pastDiscountsIneffective: SignalDefinition<boolean> = {
  id: "pastDiscountsIneffective",
  scope: "customer",
  kind: "brake",
  compute: (ctx) => {
    const paid = ctx.profile.intervention_outcomes.filter((o) => o.spend_paise > 0);
    const attempts = paid.reduce((sum, o) => sum + o.attempts, 0);
    const conversions = paid.reduce((sum, o) => sum + o.conversions, 0);
    return attempts >= INEFFECTIVE_DISCOUNT_MIN_ATTEMPTS && conversions === 0;
  },
  measure: (ctx) => {
    const paid = ctx.profile.intervention_outcomes.filter((o) => o.spend_paise > 0);
    const attempts = paid.reduce((sum, o) => sum + o.attempts, 0);
    const conversions = paid.reduce((sum, o) => sum + o.conversions, 0);
    if (attempts === 0) return "no discount has been tried on this customer yet";
    return (
      `${conversions} of ${attempts} past discount(s) across all agents were taken up ` +
      `(threshold: ${INEFFECTIVE_DISCOUNT_MIN_ATTEMPTS}+ tried and none taken up)`
    );
  },
  effects: (value) => (value ? { blocksDiscount: true } : {}),
};

// Renamed from compositeChurnSignal. Two or more DISTINCT domains with at least
// one event in the CHURN_LOOKBACK_DAYS immediately preceding and including the
// triggering event. The triggering event counts as one of them.
//
// Recency-bounded and self-ageing by construction, which is what makes it the
// soundest brake we have.
//
// IT NO LONGER BLOCKS SPEND — it only escalates. Blocking was backwards: we
// detect that a customer is leaving and respond by refusing to spend anything on
// keeping them, and then hand a person a case with no budget to work with. The
// argument for this signal was always that another automated nudge will not fix
// it, and that argument supports the handoff, not the block.
//
// It is also now the ONLY signal that escalates. Blocking and escalating used to
// be welded together in all three brakes that had either, which forced a human
// handoff on 41.9% of all events — no merchant can staff that, and it made the
// last run's headline revenue number a measure of handoff volume rather than of
// spending judgment.
const recentMultiDomainTrouble: SignalDefinition<boolean> = {
  id: "recentMultiDomainTrouble",
  scope: "customer",
  kind: "brake",
  compute(ctx) {
    const asOfMs = Date.parse(ctx.event.timestamp);
    const floorMs = asOfMs - CHURN_LOOKBACK_DAYS * DAY_MS;
    const domains = new Set<AgentType>();
    for (const e of ctx.profile.recovery_activity.recent_events) {
      const ts = Date.parse(e.timestamp);
      if (ts <= asOfMs && ts >= floorMs) domains.add(e.agent);
    }
    return domains.size >= 2;
  },
  measure(ctx) {
    const asOfMs = Date.parse(ctx.event.timestamp);
    const floorMs = asOfMs - CHURN_LOOKBACK_DAYS * DAY_MS;
    const domains = new Set<AgentType>();
    for (const e of ctx.profile.recovery_activity.recent_events) {
      const ts = Date.parse(e.timestamp);
      if (ts <= asOfMs && ts >= floorMs) domains.add(e.agent);
    }
    const names = [...domains].map((d) => d.replace(/_/g, " ")).join(" + ");
    return domains.size >= 2
      ? `${domains.size} different recovery flows fired within ${CHURN_LOOKBACK_DAYS} days: ${names}. Another automated nudge does not resolve this shape.`
      : `${domains.size} recovery flow(s) in the last ${CHURN_LOOKBACK_DAYS} days (2+ distinct flows would indicate churn)`;
  },
  effects: (value) => (value ? { forcesEscalation: true } : {}),
};

// The one accelerator. TWO conditions now, not one: a count says whether they
// have paid, only an amount says whether it was worth anything. Measured on the
// batch, the count alone admitted lifetime spends from ₹398 to ₹14,298 — all
// granted the identical extra margin.
//
// This absorbs what would have been a separate `highValueCustomer` signal. Two
// accelerators reading the same two facts and widening the same ceiling is
// duplication, not nuance.
//
// Still purely factual: it does not check for repeat patterns or disputes, and
// the precedence rule in resolveSignalEffects (brakes take the minimum) is what
// settles a customer who is both established and suspect.
const provenPayer: SignalDefinition<boolean> = {
  id: "provenPayer",
  scope: "customer",
  kind: "accelerator",
  compute: (ctx) =>
    ctx.profile.successful_payment_count >= MIN_SUCCESSFUL_PAYMENTS &&
    ctx.profile.total_paid_amount >= MIN_LIFETIME_PAID_PAISE,
  measure: (ctx) =>
    `${ctx.profile.successful_payment_count} successful payment(s) across all domains, ` +
    `${rupees(ctx.profile.total_paid_amount)} lifetime ` +
    `(established means ${MIN_SUCCESSFUL_PAYMENTS}+ payments and ${rupees(MIN_LIFETIME_PAID_PAISE)}+)`,
  effects: (value) => (value ? { discountCapPercent: PROVEN_PAYER_DISCOUNT_CAP_PERCENT } : {}),
};

// Order here is the order signals appear in the generated policy block.
// Brakes first, then the accelerator, then context: the model should read what
// it must not do before what it may.
//
// EVERY SIGNAL HERE HAS AN EFFECT OR IS TAGGED `context`. Three of the previous
// nine did nothing at all while being labelled brakes.
export const SIGNAL_DEFINITIONS = {
  disputeCautionLevel,
  repeatRecoveryWithThisAgent,
  repeatRecoveryAcrossAgents,
  discountLimitReached,
  crossAgentSpendLimitReached,
  pastDiscountsIneffective,
  recentMultiDomainTrouble,
  provenPayer,
  discountsGrantedByThisAgent,
} satisfies Record<string, AnySignalDefinition>;
