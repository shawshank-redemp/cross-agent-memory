import type Database from "better-sqlite3";
import type { z } from "zod";
import { getMemoryProfile, type PolicyOverrideRecord } from "../memory/profile.js";
import type { AgentType, Customer, CustomerMemoryProfile } from "../types/index.js";
import { decide } from "./claudeClient.js";
import { computeMemorySignals, type MemorySignals } from "./policy.js";
import { emitTrace, type TraceContext } from "./trace.js";

// What decideWithMemory returns alongside the decision itself: the signals the
// decision was made against, and the override record if enforcePolicy stepped
// in. The runner writes both onto the decision's audit row — they are the
// evidence for "the LLM proposes, deterministic code disposes", and they only
// exist on the memory path.
export interface MemoryAuditTrail {
  signals: MemorySignals;
  policy_override: PolicyOverrideRecord | null;
}

export type WithMemoryAudit<T> = T & MemoryAuditTrail;

export const MEMORY_POLICY_BLOCK = `
You also have this customer's shared memory profile, aggregated across ALL
of Razorpay's recovery agents (Cart Abandonment, Subscription Recovery,
Dispute Responder) — not just your own agent's past interactions with them:

- dispute_count / total_disputed_amount: disputes this customer has filed,
  and for how much.
- dispute_breakdown: those disputes split by what is KNOWN right now —
  unresolved (filed, no ruling yet), won (resolved in the customer's
  favour), adverse (resolved against them), closed_undetermined (ended with
  no ruling either way).
- rolling_health_score (0-100, lower = riskier): a composite risk score.
- discount_usage_history: every discount ANY agent has already granted this
  customer in this run.
- recovery_frequency: how many times each agent's triggering event has
  fired for this customer, and over what time window.
- recent_decisions: the last few decisions any agent made for this customer,
  with their reasoning.

You are also given precomputed policy_signals — treat these as hard
constraints, not suggestions:
- dispute_caution_warranted / dispute_caution_level: how much this
  customer's dispute history should tighten your discounting. Read the
  level, not just the boolean:
  - "none": no dispute counts against them. Discount normally, capped at
    20% of amount/plan_amount. This includes a customer whose disputes were
    all WON — a customer who was right to complain is not a risk, and a
    merchant losing a chargeback is evidence about the merchant's delivery,
    not about the customer. Do not treat a won dispute as a black mark.
  - "unresolved": they have a dispute filed with no ruling yet. That is
    genuine uncertainty, not established fault. Cap any discount at 15% and
    say the uncertainty is why.
  - "adverse": a dispute has been resolved AGAINST them. Cap any discount
    at 10% and prefer a plain nudge over a discount unless the amount
    involved is small.
- stopping_rule_hit: this agent has already granted 3+ discounts to this
  customer in this run. If true, you MUST NOT grant another discount.
- gaming_suspected: this customer has triggered this agent's recovery flow
  3+ times — a pattern consistent with exploiting the discount nudge rather
  than genuine difficulty paying. If true, you MUST NOT grant another
  discount and MUST set escalate_to_human=true, and say so explicitly.
- cross_agent_gaming_suspected: this customer has triggered recovery flows
  5+ times in TOTAL across any combination of agents (cart abandonment +
  subscription recovery + dispute), even if no single agent's flow alone
  hit the 3+ threshold above. Spreading triggers across agents instead of
  repeating one is still farming recovery flows. If true, treat it exactly
  like gaming_suspected: you MUST NOT grant another discount and MUST set
  escalate_to_human=true, and name the cross-agent pattern explicitly.
- composite_churn_signal: 2+ of this customer's recovery flows
  (cart/subscription/dispute) have fired within roughly a two-week window —
  a real churn risk that another automated nudge won't fix. If true, you
  MUST NOT grant another discount and MUST set escalate_to_human=true
  regardless of your other reasoning.

In your reasoning (2-4 sentences, per the schema), briefly name what from
memory drove the decision — do not narrate the full profile or restate
every field.`;

interface MemoryDecisionShape {
  action: string;
  discount_amount: number | null;
  escalate_to_human: boolean;
  reasoning: string;
}

export interface DecideWithMemoryParams<Schema extends z.ZodType<MemoryDecisionShape>> {
  db: Database.Database;
  customer: Customer;
  agent: AgentType;
  event: unknown;
  // The triggering event's own id — keys this decision's trace steps
  // (agent_trace_events) alongside customer_id/mode.
  eventId: string;
  // The triggering event's own timestamp — caps what memory this decision
  // can see to that event's own past, so gaming/churn signals only fire
  // once prior occurrences have actually happened (see profile.ts's asOf).
  eventTimestamp: string;
  systemPrompt: string;
  schema: Schema;
  fallbackNonDiscountAction: z.infer<Schema>["action"];
  memoryReadReason: string;
}

function describeProfileForTrace(profile: CustomerMemoryProfile): string {
  const entries = profile.discount_usage_history.length;
  const b = profile.dispute_breakdown;
  return [
    `dispute_count: ${profile.dispute_count}`,
    `disputes(unresolved/won/adverse/closed): ${b.unresolved}/${b.won}/${b.adverse}/${b.closed_undetermined}`,
    `recovery_frequency: ${profile.recovery_frequency.length} agents`,
    `discount_history: ${entries} entr${entries === 1 ? "y" : "ies"}`,
  ].join(", ");
}

function describeSignalsForTrace(signals: MemorySignals): string {
  const active: string[] = [];
  if (signals.disputeCautionWarranted) active.push(`dispute_caution:${signals.disputeCautionLevel}`);
  if (signals.stoppingRuleHit) active.push("stopping_rule_hit");
  if (signals.gamingSuspected) active.push("gaming_suspected");
  if (signals.crossAgentGamingSuspected) active.push("cross_agent_gaming_suspected");
  if (signals.compositeChurnSignal) active.push("composite_churn_signal");
  return active.length > 0 ? active.join(", ") : "none";
}

export async function decideWithMemory<Schema extends z.ZodType<MemoryDecisionShape>>(
  params: DecideWithMemoryParams<Schema>,
): Promise<WithMemoryAudit<z.infer<Schema>>> {
  const traceBase: Omit<TraceContext, "stepOrder"> = {
    db: params.db,
    customerId: params.customer.customer_id,
    eventId: params.eventId,
    agent: params.agent,
    mode: "memory",
  };
  let stepOrder = 0;

  let stepStart = Date.now();
  const profile = getMemoryProfile(params.db, params.customer.customer_id, {
    requestedBy: params.agent,
    mode: "memory",
    reason: params.memoryReadReason,
    asOf: params.eventTimestamp,
    eventId: params.eventId,
  });
  stepOrder += 1;
  emitTrace(
    { ...traceBase, stepOrder },
    "read_memory_profile",
    describeProfileForTrace(profile),
    Date.now() - stepStart,
  );

  stepStart = Date.now();
  const signals = computeMemorySignals(profile, params.agent);
  stepOrder += 1;
  emitTrace(
    { ...traceBase, stepOrder },
    "evaluate_policy_signals",
    describeSignalsForTrace(signals),
    Date.now() - stepStart,
  );

  const recentDecisions = profile.audit_log.filter((e) => e.entry_type === "decision").slice(-5);
  const userContent = JSON.stringify(
    {
      customer: params.customer,
      event: params.event,
      memory_profile: {
        dispute_count: profile.dispute_count,
        total_disputed_amount: profile.total_disputed_amount,
        dispute_breakdown: profile.dispute_breakdown,
        adverse_disputed_amount: profile.adverse_disputed_amount,
        rolling_health_score: profile.rolling_health_score,
        discount_usage_history: profile.discount_usage_history,
        recovery_frequency: profile.recovery_frequency,
        recent_decisions: recentDecisions,
      },
      policy_signals: signals,
    },
    null,
    2,
  );

  stepStart = Date.now();
  const decision = await decide(`${params.systemPrompt}\n${MEMORY_POLICY_BLOCK}`, userContent, params.schema);
  stepOrder += 1;
  emitTrace({ ...traceBase, stepOrder }, "agent_reasoning", decision.reasoning, Date.now() - stepStart);

  stepOrder += 1;
  return enforcePolicy(decision, signals, params.fallbackNonDiscountAction, traceBase, stepOrder);
}

// Which signals actually caused an override, named the same way they are in
// MemorySignals so the audit row points at a real field rather than prose.
function overrideTriggers(signals: MemorySignals, mustBlockDiscount: boolean, mustEscalate: boolean): string[] {
  const triggers: (keyof MemorySignals)[] = [];
  if (mustBlockDiscount && signals.stoppingRuleHit) triggers.push("stoppingRuleHit");
  if (signals.gamingSuspected && (mustBlockDiscount || mustEscalate)) triggers.push("gamingSuspected");
  if (signals.crossAgentGamingSuspected && (mustBlockDiscount || mustEscalate)) {
    triggers.push("crossAgentGamingSuspected");
  }
  if (signals.compositeChurnSignal && (mustBlockDiscount || mustEscalate)) triggers.push("compositeChurnSignal");
  return triggers;
}

// Safety net: an LLM call is not a reliable place to enforce a hard, bounded
// limit — the stopping rule and churn escalation are deterministic
// overrides, applied here regardless of what the model returned, with the
// original reasoning preserved and the override noted for the audit trail.
function enforcePolicy<D extends MemoryDecisionShape>(
  decision: D,
  signals: MemorySignals,
  fallbackNonDiscountAction: D["action"],
  traceBase: Omit<TraceContext, "stepOrder">,
  stepOrder: number,
): WithMemoryAudit<D> {
  const stepStart = Date.now();
  const mustBlockDiscount =
    (signals.stoppingRuleHit || signals.gamingSuspected || signals.crossAgentGamingSuspected || signals.compositeChurnSignal) &&
    decision.discount_amount != null;
  const mustEscalate =
    (signals.gamingSuspected || signals.crossAgentGamingSuspected || signals.compositeChurnSignal) &&
    !decision.escalate_to_human;

  if (!mustBlockDiscount && !mustEscalate) return { ...decision, signals, policy_override: null };

  const notes: string[] = [];
  if (mustBlockDiscount && (signals.stoppingRuleHit || signals.gamingSuspected || signals.crossAgentGamingSuspected)) {
    notes.push("stopping-rule/gaming signal forbids another discount here");
  }
  if (mustBlockDiscount && signals.compositeChurnSignal) notes.push("composite churn signal forbids another discount here");
  if (signals.crossAgentGamingSuspected) notes.push("cross-agent gaming signal (5+ recovery events total across agents)");
  if (mustEscalate) notes.push("gaming or composite-churn signal requires escalation");

  const preOverrideDiscountAmount = decision.discount_amount;
  const notesJoined = notes.join("; ");

  emitTrace(
    { ...traceBase, stepOrder },
    "policy_override",
    `${notesJoined}; pre_override_discount_amount: ${preOverrideDiscountAmount ?? "null"}`,
    Date.now() - stepStart,
  );

  return {
    ...decision,
    action: mustBlockDiscount ? fallbackNonDiscountAction : decision.action,
    discount_amount: mustBlockDiscount ? null : decision.discount_amount,
    escalate_to_human: true,
    reasoning: `${decision.reasoning}\n\n[POLICY OVERRIDE] ${notesJoined}.`,
    signals,
    policy_override: {
      original_action: decision.action,
      original_discount_amount: preOverrideDiscountAmount,
      original_escalate_to_human: decision.escalate_to_human,
      triggered_by: overrideTriggers(signals, mustBlockDiscount, mustEscalate),
      notes: notesJoined,
    },
  };
}
