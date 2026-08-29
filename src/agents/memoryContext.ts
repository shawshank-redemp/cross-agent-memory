import type Database from "better-sqlite3";
import type { z } from "zod";
import { getMemoryProfile, type PolicyOverrideRecord } from "../memory/profile.js";
import type { MemoryProfilePayload } from "./memoryPayloadKeys.js";
import { withClosingInstruction } from "./objective.js";
import { SIGNAL_REGISTRY } from "./signals/registry.js";
import type { AgentType, Customer, CustomerMemoryProfile } from "../types/index.js";
import { decide } from "./claudeClient.js";
import {
  buildSignalPolicyText,
  computeMemorySignals,
  resolveSignalEffects,
  signalsNotInProse,
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
  // Signal ids the model cited in memory_factors_used that were not actually
  // active. Recorded, never corrected — see unsupportedFactorCitations.
  unsupported_factor_citations: string[];
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
- dispute_breakdown (present only when no dispute finding is stated below):
  those disputes split by what is KNOWN right now —
  unresolved (filed, no ruling yet), merchant_conceded (the merchant lost or
  accepted the chargeback and the customer was refunded), customer_adverse
  (the merchant contested it successfully — the complaint did not hold up),
  closed_undetermined (ended with no ruling either way).
- unresolved_dispute_reasons (same condition): why the still-open disputes
  were filed. At
  decision time most disputes ARE unresolved, so the reason is usually the
  only evidence about who is likely at fault.
- successful_payment_count / total_paid_amount: how much this customer has
  successfully transacted with us, across every domain.
- rolling_health_score (0-100, lower = riskier): a composite risk score.
- discount_usage_history: every discount ANY agent has already granted this
  customer in this run.
- recent_decisions: the last few decisions any agent made for this customer —
  what was decided and what it cost, without the prose. Treat them as history,
  not as precedent you are expected to follow.`;

// The signal half is GENERATED from the registry's describe() outputs, so the
// prompt cannot drift away from what enforcePolicy actually does — both are
// read off the same registry entry. Only signals that actually apply to THIS
// customer are included; the full values still go over as policy_signals JSON.
export function buildMemoryPolicyBlock(signals: MemorySignals): string {
  return `${MEMORY_PROFILE_PREAMBLE}

WHAT THIS CUSTOMER'S HISTORY SHOWS, and what policy permits given it:

${buildSignalPolicyText(signals)}

These are findings, not instructions. Weigh them as evidence about this case
and reach your own judgment. Name in memory_factors_used only the facts your
reasoning actually used — an empty list is correct when none of them mattered.`;
}

interface MemoryDecisionShape {
  reasoning: string;
  memory_factors_used: string[];
  action: string;
  committed_spend_paise: number | null;
  escalate_to_human: boolean;
  escalation_reason: string | null;
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



// The request payload, deliberately trimmed.
//
// Three things used to be sent that are now not:
//
//   recent_decisions carried each entry's full reasoning prose — the single
//   largest block in the request, and actively harmful beyond its cost: the
//   model reads its own past arguments and tends to agree with them, so a
//   customer's timeline compounds an early judgment instead of re-examining
//   it. Structured facts only now.
//
//   policy_signals echoed every signal the generated prose already states.
//   Only the ones NOT in the prose are sent, plus every numeric value
//   regardless — magnitude is information prose does not carry well.
//
//   recovery_frequency windows are vestigial: composite churn reads
//   recent_events now, and nothing else consumed the windows.
//   dispute_breakdown and unresolved_dispute_reasons are dropped only when a
//   dispute caution level is already stated in prose, since in that case the
//   prose says what they would say. total_disputed_amount is always kept — a
//   small dispute and a large one are different facts that no signal captures.
function buildUserContent(
  customer: Customer,
  event: unknown,
  profile: CustomerMemoryProfile,
  signals: MemorySignals,
): string {
  const recentDecisions = profile.audit_log
    .filter((e) => e.entry_type === "decision")
    .slice(-5)
    .map((e) => ({
      agent: e.agent,
      action: e.action,
      committed_spend_paise: e.committed_spend_paise,
      timestamp: e.timestamp,
    }));

  const disputeStatedInProse = signals.disputeCautionLevel !== "none";

  // Typed against MEMORY_PROFILE_*_KEYS: every always-key is required, the
  // conditional keys are optional, and any other key is a compile error. That
  // is what keeps memory_factors_used' enum honest — the citable set is
  // derived from these same keys.
  const memoryProfile: MemoryProfilePayload = {
    dispute_count: profile.dispute_count,
    total_disputed_amount: profile.total_disputed_amount,
    successful_payment_count: profile.successful_payment_count,
    total_paid_amount: profile.total_paid_amount,
    rolling_health_score: profile.rolling_health_score,
    discount_usage_history: profile.discount_usage_history,
    recent_decisions: recentDecisions,
  };
  if (!disputeStatedInProse) {
    memoryProfile.dispute_breakdown = profile.dispute_breakdown;
    memoryProfile.unresolved_dispute_reasons = profile.unresolved_dispute_reasons;
    memoryProfile.adverse_disputed_amount = profile.adverse_disputed_amount;
  }

  const payload = JSON.stringify(
    {
      customer,
      event,
      memory_profile: memoryProfile,
      policy_signals: {
        ...signalsNotInProse(signals),
        // Always sent regardless of the prose: a count is a magnitude, and
        // "already discounted twice" reads differently from "already
        // discounted once".
        discountAttemptsForAgent: signals.discountAttemptsForAgent,
      },
    },
    null,
    2,
  );

  // Shared with the baseline arm — see CLOSING_INSTRUCTION.
  return withClosingInstruction(payload);
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

  const userContent = buildUserContent(params.customer, params.event, profile, signals);

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

  const mustBlockDiscount = resolved.blocksDiscount && decision.committed_spend_paise != null;
  const mustEscalate = resolved.forcesEscalation && !decision.escalate_to_human;
  // Only meaningful when the discount survives: a blocked discount is removed
  // outright, so there is nothing left to clamp.
  const mustCap =
    !mustBlockDiscount && decision.committed_spend_paise != null && decision.committed_spend_paise > capPaise;

  if (!mustBlockDiscount && !mustEscalate && !mustCap) {
    return {
      ...decision,
      escalation_reason: normalizeEscalationReason(decision.escalate_to_human, decision.escalation_reason),
      signals,
      policy_override: null,
      unsupported_factor_citations: unsupportedFactorCitations(decision.memory_factors_used, signals),
    };
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

  const preOverrideSpend = decision.committed_spend_paise;
  const notesJoined = notes.join("; ");

  emitTrace(
    { ...traceBase, stepOrder },
    "policy_override",
    `${notesJoined}; pre_override_committed_spend_paise: ${preOverrideSpend ?? "null"}`,
    Date.now() - stepStart,
  );

  const committedSpend = mustBlockDiscount ? null : mustCap ? capPaise : decision.committed_spend_paise;
  const escalated = mustBlockDiscount || mustEscalate ? true : decision.escalate_to_human;
  // True only when policy escalated a decision the model did not escalate.
  const forcedEscalation = escalated && !decision.escalate_to_human;

  return {
    ...decision,
    action: mustBlockDiscount ? fallbackNonDiscountAction : decision.action,
    committed_spend_paise: committedSpend,
    // Capping alone does not force escalation — the decision still stands, it
    // is just priced within policy.
    escalate_to_human: escalated,
    // When policy is what forced the escalation, the reason is policy — not
    // whatever the model said (or failed to say) when it did not intend to
    // escalate at all.
    escalation_reason: forcedEscalation
      ? "policy_constraint"
      : normalizeEscalationReason(escalated, decision.escalation_reason),
    reasoning: `${decision.reasoning}\n\n[POLICY OVERRIDE] ${notesJoined}.`,
    signals,
    policy_override: {
      original_action: decision.action,
      original_committed_spend_paise: preOverrideSpend,
      original_escalate_to_human: decision.escalate_to_human,
      triggered_by: [...triggeredBy],
      notes: notesJoined,
      escalation_reason_forced: forcedEscalation,
    },
    unsupported_factor_citations: unsupportedFactorCitations(decision.memory_factors_used, signals),
  };
}

// escalate_to_human and escalation_reason must agree: a reason without an
// escalation is noise, and an escalation without a reason is an unexplained
// handoff. Normalised deterministically here rather than as a zod .refine(),
// because a refinement failure under constrained decoding costs a whole retry
// call to fix what is a one-line coercion.
function normalizeEscalationReason(escalated: boolean, reason: string | null): string | null {
  if (!escalated) return null;
  return reason ?? "ambiguous_case";
}

// memory_factors_used is SELF-REPORTED. This counts citations the evidence does
// not support — a signal named as decisive while that signal was inactive.
//
// It deliberately does NOT overwrite or "correct" the model's answer. The
// model's stated reasoning is the artifact being measured; silently editing it
// would destroy the thing we are trying to observe. Profile-field citations
// (dispute_breakdown, recent_decisions, ...) are not checkable this way — the
// field was sent, so citing it is never provably unsupported — so only signal
// citations are audited.
function unsupportedFactorCitations(factors: string[], signals: MemorySignals): string[] {
  const unsupported: string[] = [];
  for (const factor of factors) {
    if (!(factor in SIGNAL_REGISTRY)) continue;
    const value = (signals as Record<string, unknown>)[factor];
    const inactive = value === false || value === "none" || value === 0;
    if (inactive) unsupported.push(factor);
  }
  return unsupported;
}
