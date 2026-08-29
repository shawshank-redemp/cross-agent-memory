import type Database from "better-sqlite3";
import type { z } from "zod";
import { getMemoryProfile, type PolicyOverrideRecord } from "../memory/profile.js";
import type { AgentType, Customer, CustomerMemoryProfile } from "../types/index.js";
import { decide } from "./claudeClient.js";
import {
  buildSignalPolicyText,
  computeMemorySignals,
  resolveSignalEffects,
  summarizeActiveSignals,
  type MemorySignals,
  type SignalId,
  type TriggeringEventFacts,
} from "./policy.js";
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

// Static half of the policy block: what the memory profile CONTAINS. This is
// the same for every decision, so it stays hand-written.
const MEMORY_PROFILE_PREAMBLE = `
You also have this customer's shared memory profile, aggregated across ALL
of Razorpay's recovery agents (Cart Abandonment, Subscription Recovery,
Dispute Responder) — not just your own agent's past interactions with them:

- dispute_count / total_disputed_amount: disputes this customer has filed,
  and for how much.
- dispute_breakdown: those disputes split by what is KNOWN right now —
  unresolved (filed, no ruling yet), merchant_conceded (the merchant lost or
  accepted the chargeback and the customer was refunded), customer_adverse
  (the merchant contested it successfully — the complaint did not hold up),
  closed_undetermined (ended with no ruling either way).
- unresolved_dispute_reasons: why the still-open disputes were filed. At
  decision time most disputes ARE unresolved, so the reason is usually the
  only evidence about who is likely at fault.
- successful_payment_count / total_paid_amount: how much this customer has
  successfully transacted with us, across every domain.
- rolling_health_score (0-100, lower = riskier): a composite risk score.
- discount_usage_history: every discount ANY agent has already granted this
  customer in this run.
- recovery_frequency: how many times each agent's triggering event has
  fired for this customer, and over what time window.
- recent_decisions: the last few decisions any agent made for this customer,
  with their reasoning.`;

// The signal half is GENERATED from the registry's describe() outputs, so the
// prompt cannot drift away from what enforcePolicy actually does — both are
// read off the same registry entry. Only signals that actually apply to THIS
// customer are included; the full values still go over as policy_signals JSON.
export function buildMemoryPolicyBlock(signals: MemorySignals): string {
  return `${MEMORY_PROFILE_PREAMBLE}

You are also given precomputed policy_signals. Treat these as hard
constraints, not suggestions — the ones that apply here are:

${buildSignalPolicyText(signals)}

In your reasoning (2-4 sentences, per the schema), briefly name what from
memory drove the decision — do not narrate the full profile or restate
every field.`;
}

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
  // Normalised facts about the triggering event, built by the agent module
  // that owns the event's shape. Read by signals that look at the event
  // itself rather than at memory (see TriggeringEventFacts).
  eventFacts: Omit<TriggeringEventFacts, "agent" | "timestamp">;
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
    `disputes(unresolved/merchant_conceded/customer_adverse/closed): ${b.unresolved}/${b.merchant_conceded}/${b.customer_adverse}/${b.closed_undetermined}`,
    `recovery_frequency: ${profile.recovery_frequency.length} agents`,
    `discount_history: ${entries} entr${entries === 1 ? "y" : "ies"}`,
  ].join(", ");
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
  const eventFacts: TriggeringEventFacts = {
    ...params.eventFacts,
    agent: params.agent,
    timestamp: params.eventTimestamp,
  };
  const signals = computeMemorySignals(profile, eventFacts);
  stepOrder += 1;
  emitTrace(
    { ...traceBase, stepOrder },
    "evaluate_policy_signals",
    summarizeActiveSignals(signals),
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
        unresolved_dispute_reasons: profile.unresolved_dispute_reasons,
        successful_payment_count: profile.successful_payment_count,
        total_paid_amount: profile.total_paid_amount,
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
  const decision = await decide(
    `${params.systemPrompt}\n${buildMemoryPolicyBlock(signals)}`,
    userContent,
    params.schema,
  );
  stepOrder += 1;
  emitTrace({ ...traceBase, stepOrder }, "agent_reasoning", decision.reasoning, Date.now() - stepStart);

  stepOrder += 1;
  return enforcePolicy(decision, signals, eventFacts, params.fallbackNonDiscountAction, traceBase, stepOrder);
}

// Safety net: an LLM call is not a reliable place to enforce a hard, bounded
// limit, so the constraints are applied here deterministically regardless of
// what the model returned, with the original reasoning preserved and the
// override recorded for the audit trail.
//
// Every condition below is resolved from the registry rather than tested
// against hardcoded signal names. That is the anti-drift property: a signal
// that declares blocksDiscount is enforced here the moment it is registered,
// without anyone remembering to add a clause — which is precisely what went
// wrong in the churn-signal discount gap (commit 75f04a3).
function enforcePolicy<D extends MemoryDecisionShape>(
  decision: D,
  signals: MemorySignals,
  event: TriggeringEventFacts,
  fallbackNonDiscountAction: D["action"],
  traceBase: Omit<TraceContext, "stepOrder">,
  stepOrder: number,
): WithMemoryAudit<D> {
  const stepStart = Date.now();
  const resolved = resolveSignalEffects(signals);
  const capPaise = Math.floor((event.amount * resolved.discountCapPercent) / 100);

  const mustBlockDiscount = resolved.blocksDiscount && decision.discount_amount != null;
  const mustEscalate = resolved.forcesEscalation && !decision.escalate_to_human;
  // Only meaningful when the discount survives: a blocked discount is removed
  // outright, so there is nothing left to clamp.
  const mustCap =
    !mustBlockDiscount && decision.discount_amount != null && decision.discount_amount > capPaise;

  if (!mustBlockDiscount && !mustEscalate && !mustCap) {
    return { ...decision, signals, policy_override: null };
  }

  const notes: string[] = [];
  const triggeredBy = new Set<SignalId>();
  if (mustBlockDiscount) {
    notes.push(`discount blocked by: ${resolved.blockingSignals.join(", ")}`);
    for (const id of resolved.blockingSignals) triggeredBy.add(id);
  }
  if (mustEscalate) {
    notes.push(`escalation forced by: ${resolved.escalatingSignals.join(", ")}`);
    for (const id of resolved.escalatingSignals) triggeredBy.add(id);
  }
  if (mustCap) {
    notes.push(
      `discount clamped to the ${resolved.discountCapPercent}% ceiling (${capPaise} paise)` +
        (resolved.cappingSignal ? ` set by ${resolved.cappingSignal}` : ""),
    );
    if (resolved.cappingSignal) triggeredBy.add(resolved.cappingSignal);
  }

  const preOverrideDiscountAmount = decision.discount_amount;
  const notesJoined = notes.join("; ");

  emitTrace(
    { ...traceBase, stepOrder },
    "policy_override",
    `${notesJoined}; pre_override_discount_amount: ${preOverrideDiscountAmount ?? "null"}`,
    Date.now() - stepStart,
  );

  const discountAmount = mustBlockDiscount ? null : mustCap ? capPaise : decision.discount_amount;

  return {
    ...decision,
    action: mustBlockDiscount ? fallbackNonDiscountAction : decision.action,
    discount_amount: discountAmount,
    // Capping alone does not force escalation — the decision still stands, it
    // is just priced within policy.
    escalate_to_human: mustBlockDiscount || mustEscalate ? true : decision.escalate_to_human,
    reasoning: `${decision.reasoning}\n\n[POLICY OVERRIDE] ${notesJoined}.`,
    signals,
    policy_override: {
      original_action: decision.action,
      original_discount_amount: preOverrideDiscountAmount,
      original_escalate_to_human: decision.escalate_to_human,
      triggered_by: [...triggeredBy],
      notes: notesJoined,
    },
  };
}
