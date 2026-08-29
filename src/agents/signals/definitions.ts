import { disputeFaultForReason } from "../../data/fixtures.js";
import type { AgentType } from "../../types/index.js";
import {
  CHURN_LOOKBACK_DAYS,
  DEFAULT_DISCOUNT_CAP_PERCENT,
  DISCOUNT_CAP_PERCENT_BY_CAUTION_LEVEL,
  MAX_DISCOUNT_ATTEMPTS_PER_AGENT,
  MAX_TOTAL_RECOVERY_EVENTS_ACROSS_AGENTS,
  MIN_SUCCESSFUL_PAYMENTS,
  PROVEN_PAYER_DISCOUNT_CAP_PERCENT,
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

const DISPUTE_CAUTION_PROMPT: Record<DisputeCautionLevel, string | null> = {
  none: null,
  unresolved_merchant_fault:
    'dispute_caution_level = "unresolved_merchant_fault": this customer has an unresolved dispute, but its reason points at the MERCHANT (goods not received, service not as described). That is not evidence against them. Discount normally, capped at ' +
    `${DISCOUNT_CAP_PERCENT_BY_CAUTION_LEVEL.unresolved_merchant_fault}% of the event amount, and do not treat the dispute as a black mark.`,
  unresolved_neutral:
    'dispute_caution_level = "unresolved_neutral": an unresolved dispute whose reason points at neither side (duplicate charge, subscription not cancelled). Genuine uncertainty, not established fault. Cap any discount at ' +
    `${DISCOUNT_CAP_PERCENT_BY_CAUTION_LEVEL.unresolved_neutral}% and say the uncertainty is why.`,
  unresolved_customer_fault:
    'dispute_caution_level = "unresolved_customer_fault": an unresolved dispute whose reason points at the CUSTOMER (they do not recognise their own transaction). No ruling yet, but this is the one unresolved shape that warrants real caution. Cap any discount at ' +
    `${DISCOUNT_CAP_PERCENT_BY_CAUTION_LEVEL.unresolved_customer_fault}%.`,
  adverse:
    'dispute_caution_level = "adverse": a dispute was resolved against this customer — the merchant contested it and the complaint did not hold up. Cap any discount at ' +
    `${DISCOUNT_CAP_PERCENT_BY_CAUTION_LEVEL.adverse}% and prefer a plain nudge over a discount unless the amount involved is small.`,
};

const disputeCautionLevel: SignalDefinition<DisputeCautionLevel> = {
  id: "disputeCautionLevel",
  scope: "customer",
  kind: "brake",
  compute: computeDisputeCautionLevel,
  describe(value) {
    return DISPUTE_CAUTION_PROMPT[value];
  },
  effects(value) {
    const cap = DISCOUNT_CAP_PERCENT_BY_CAUTION_LEVEL[value];
    // A level at or above the standing default is NOT a brake — it contributes
    // no cap at all, so it cannot hold a proven payer back from the wider
    // ceiling. Only levels that actually tighten below the default constrain.
    return cap < DEFAULT_DISCOUNT_CAP_PERCENT ? { discountCapPercent: cap } : {};
  },
};

// Derived convenience kept because consumers (the trace summary, the
// dashboard) want a plain boolean. Carries no effects of its own — the level
// signal above owns the cap — and no prompt text, since describing the same
// fact twice just costs tokens.
const disputeCautionWarranted: SignalDefinition<boolean> = {
  id: "disputeCautionWarranted",
  scope: "customer",
  kind: "brake",
  compute: (ctx) => computeDisputeCautionLevel(ctx) !== "none",
  describe: () => null,
  effects: () => ({}),
};

// The raw counter the stopping rule reads. Not itself a constraint; exposed
// because the model benefits from knowing how much has already been spent.
const discountAttemptsForAgent: SignalDefinition<number> = {
  id: "discountAttemptsForAgent",
  scope: "agent",
  kind: "brake",
  compute: (ctx) => ctx.profile.discount_usage_history.filter((d) => d.agent === ctx.agent).length,
  describe: (value) =>
    value > 0 ? `discount_attempts_for_agent = ${value}: discounts you have already granted this customer in this run.` : null,
  effects: () => ({}),
};

const stoppingRuleHit: SignalDefinition<boolean> = {
  id: "stoppingRuleHit",
  scope: "agent",
  kind: "brake",
  compute: (ctx) =>
    ctx.profile.discount_usage_history.filter((d) => d.agent === ctx.agent).length >= MAX_DISCOUNT_ATTEMPTS_PER_AGENT,
  describe: (value) =>
    value
      ? `stopping_rule_hit: you have already granted ${MAX_DISCOUNT_ATTEMPTS_PER_AGENT}+ discounts to this customer in this run. You MUST NOT grant another discount.`
      : null,
  effects: (value) => (value ? { blocksDiscount: true } : {}),
};

const gamingSuspected: SignalDefinition<boolean> = {
  id: "gamingSuspected",
  scope: "agent",
  kind: "brake",
  compute: (ctx) =>
    (ctx.profile.recovery_frequency.find((r) => r.agent === ctx.agent)?.count ?? 0) >= MAX_DISCOUNT_ATTEMPTS_PER_AGENT,
  describe: (value) =>
    value
      ? `gaming_suspected: this customer has triggered your recovery flow ${MAX_DISCOUNT_ATTEMPTS_PER_AGENT}+ times — a pattern consistent with exploiting the discount nudge rather than genuine difficulty paying. You MUST NOT grant another discount and MUST set escalate_to_human=true, and say so explicitly.`
      : null,
  effects: (value) => (value ? { blocksDiscount: true, forcesEscalation: true } : {}),
};

const crossAgentGamingSuspected: SignalDefinition<boolean> = {
  id: "crossAgentGamingSuspected",
  scope: "customer",
  kind: "brake",
  // recovery_frequency is already asOf-scoped (see profile.ts), so summing it
  // here stays causal for free.
  compute: (ctx) =>
    ctx.profile.recovery_frequency.reduce((sum, r) => sum + r.count, 0) >= MAX_TOTAL_RECOVERY_EVENTS_ACROSS_AGENTS,
  describe: (value) =>
    value
      ? `cross_agent_gaming_suspected: this customer has triggered recovery flows ${MAX_TOTAL_RECOVERY_EVENTS_ACROSS_AGENTS}+ times in TOTAL across any combination of agents, even if no single agent's flow hit its own threshold. Spreading triggers across agents instead of repeating one is still farming recovery flows. You MUST NOT grant another discount and MUST set escalate_to_human=true, naming the cross-agent pattern explicitly.`
      : null,
  effects: (value) => (value ? { blocksDiscount: true, forcesEscalation: true } : {}),
};

// Two or more DISTINCT domains with at least one event in the
// CHURN_LOOKBACK_DAYS immediately preceding and including the triggering
// event. The triggering event itself counts as one of them, since
// recent_events is asOf-scoped inclusive of its own timestamp.
//
// Recency-bounded and self-ageing by construction: a cluster of trouble drops
// out once it is older than the lookback, which is the whole point of
// replacing the previous window-pair rule.
const compositeChurnSignal: SignalDefinition<boolean> = {
  id: "compositeChurnSignal",
  scope: "customer",
  kind: "brake",
  compute(ctx) {
    const asOfMs = Date.parse(ctx.event.timestamp);
    const floorMs = asOfMs - CHURN_LOOKBACK_DAYS * DAY_MS;
    const domains = new Set<AgentType>();
    for (const e of ctx.profile.recent_events) {
      const ts = Date.parse(e.timestamp);
      if (ts <= asOfMs && ts >= floorMs) domains.add(e.agent);
    }
    return domains.size >= 2;
  },
  describe: (value) =>
    value
      ? `composite_churn_signal: 2+ of this customer's recovery flows (cart/subscription/dispute) have fired within the last ${CHURN_LOOKBACK_DAYS} days — a real churn risk that another automated nudge will not fix. You MUST NOT grant another discount and MUST set escalate_to_human=true regardless of your other reasoning.`
      : null,
  effects: (value) => (value ? { blocksDiscount: true, forcesEscalation: true } : {}),
};

// The one accelerator. Purely factual: it asks "has this person successfully
// transacted with us" and nothing else. It deliberately does NOT check for
// gaming or disputes — those are separate signals, and the precedence rule in
// resolveSignalEffects (brakes take the minimum cap) is what settles a
// customer who is both proven and suspect.
const provenPayer: SignalDefinition<boolean> = {
  id: "provenPayer",
  scope: "customer",
  kind: "accelerator",
  compute: (ctx) => ctx.profile.successful_payment_count >= MIN_SUCCESSFUL_PAYMENTS,
  describe: (value) =>
    value
      ? `proven_payer: this customer has ${MIN_SUCCESSFUL_PAYMENTS}+ successful payments with us across all domains. They have earned more room than a stranger — you may go up to ${PROVEN_PAYER_DISCOUNT_CAP_PERCENT}% of the event amount, unless another signal here caps you lower.`
      : null,
  effects: (value) => (value ? { discountCapPercent: PROVEN_PAYER_DISCOUNT_CAP_PERCENT } : {}),
};

// The one router. Reads the TRIGGERING EVENT, not memory: it separates a
// customer who never reached payment (an intent problem, which a discount can
// address) from one whose payment was declined (a mechanical problem, which a
// discount does not address — they need a different method or a retry).
//
// DELIBERATELY A SOFT SIGNAL. It carries no effects, so enforcePolicy never
// overrides on it. There is no "retry with another payment method" action in
// the decision schema, and adding one would change the outcome model — a
// documented future step, out of scope here. Until then this steers the model
// through the prompt and is recorded on the audit row so its influence on
// decision divergence is still measurable.
const paymentFriction: SignalDefinition<boolean> = {
  id: "paymentFriction",
  scope: "agent",
  kind: "router",
  compute: (ctx) => ctx.event.paymentAttempted && ctx.event.paymentErrorCode != null,
  describe: (value) =>
    value
      ? "payment_friction: this customer TRIED to pay and the payment was declined — this is a mechanical failure, not a pricing objection. A discount does not address a declined card or a failed mandate. Prefer a reminder that surfaces an alternative payment method, and say in your reasoning that the failure was mechanical."
      : null,
  effects: () => ({}),
};

// Order here is the order signals appear in the generated policy block.
// Brakes first, then the accelerator, then the router: the model should read
// what it must not do before what it may.
export const SIGNAL_DEFINITIONS = {
  disputeCautionWarranted,
  disputeCautionLevel,
  discountAttemptsForAgent,
  stoppingRuleHit,
  gamingSuspected,
  crossAgentGamingSuspected,
  compositeChurnSignal,
  provenPayer,
  paymentFriction,
} satisfies Record<string, AnySignalDefinition>;
