import type Database from "better-sqlite3";
import type { z } from "zod";
import { getMemoryProfile, type PolicyOverrideRecord } from "../memory/profile.js";
import type { MemoryProfilePayload } from "./memoryPayloadKeys.js";
import { enforceUniversalPolicy, normalizeEscalationReason } from "./enforcement.js";
import { AGENT_ACTION_POLICY } from "./schema.js";
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
  // Null only on the fail-closed path, where signals could not be computed.
  signals: MemorySignals | null;
  policy_override: PolicyOverrideRecord | null;
  // True when the guardrail itself could not be evaluated and the conservative
  // decision was substituted. Counted in the run summary — a silent fail-closed
  // is worse than a crash, because the run looks complete.
  guardrail_failed?: boolean;
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

// FAIL CLOSED. A guardrail that cannot evaluate must take the CONSERVATIVE
// action — not crash, and above all not pass model output through unguarded.
// Commits no spend, escalates to a person, and records why.
//
// Distinct from the runner's per-event catch, which handles API failures: this
// handles failures of the guardrail evaluation itself (a profile read or signal
// computation throwing). An API failure means "no decision"; this means "a
// decision we do not trust ourselves to make automatically".
function failClosed<Schema extends z.ZodType<MemoryDecisionShape>>(
  params: DecideWithMemoryParams<Schema>,
  err: unknown,
  original?: z.infer<Schema>,
): WithMemoryAudit<z.infer<Schema>> {
  const message = err instanceof Error ? err.message : String(err);
  const fallbackAction = AGENT_ACTION_POLICY[params.agent].nonSpendFallbackAction;
  console.error(
    `  !! GUARDRAIL FAILURE on ${params.agent} ${params.eventId}: ${message} — failing closed ` +
      `(no spend, escalating to a human).`,
  );

  const notes = `guardrail evaluation failed (${message}); failed closed to no spend + human review`;
  return {
    ...(original ?? {}),
    reasoning:
      (original?.reasoning ? `${original.reasoning}\n\n` : "") +
      `[FAIL CLOSED] ${notes}.`,
    memory_factors_used: [],
    action: fallbackAction,
    committed_spend_paise: null,
    escalate_to_human: true,
    escalation_reason: "policy_constraint",
    signals: null,
    policy_override: {
      original_action: original?.action ?? null,
      original_committed_spend_paise: original?.committed_spend_paise ?? null,
      original_escalate_to_human: original?.escalate_to_human ?? false,
      triggered_by: ["guardrail_evaluation_failed"],
      notes,
      escalation_reason_forced: true,
    },
    unsupported_factor_citations: [],
    guardrail_failed: true,
  } as WithMemoryAudit<z.infer<Schema>>;
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
  let profile: CustomerMemoryProfile;
  let signals: MemorySignals;
  let eventFacts: TriggeringEventFacts;
  try {
    profile = getMemoryProfile(params.db, params.customer.customer_id, {
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
    eventFacts = {
      ...params.eventFacts,
      agent: params.agent,
      timestamp: params.eventTimestamp,
    };
    signals = computeMemorySignals(profile, eventFacts);
    stepOrder += 1;
    emitTrace(
      { ...traceBase, stepOrder },
      "evaluate_policy_signals",
      summarizeActiveSignals(signals),
      Date.now() - stepStart,
    );
  } catch (err) {
    // The guardrail could not be evaluated. Do not call the model at all —
    // there is nothing to check its answer against.
    return failClosed(params, err);
  }

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
  try {
    return enforcePolicy(decision, signals, eventFacts, traceBase, stepOrder);
  } catch (err) {
    // Enforcement itself failed. The model's answer exists but is unvetted, so
    // it must not be used as-is.
    return failClosed(params, err, decision);
  }
}

// The MEMORY-DERIVED half of enforcement, layered on top of the universal
// policy every arm gets. It contributes what only memory can know: a tightened
// (or widened) ceiling, outright blocks, and forced escalation.
//
// Every condition is resolved from the signal registry rather than tested
// against hardcoded signal names. That is the anti-drift property: a signal
// that declares blocksDiscount is enforced the moment it is registered, without
// anyone remembering to add a clause — which is precisely what went wrong in
// the churn-signal discount gap (commit 75f04a3).
//
// ORDERING: the universal layer runs FIRST, so incoherent, negative, and zero
// spend are already gone by the time the block rule below could swap an action.
export function enforcePolicy<D extends MemoryDecisionShape>(
  decision: D,
  signals: MemorySignals,
  event: TriggeringEventFacts,
  traceBase: Omit<TraceContext, "stepOrder">,
  stepOrder: number,
): WithMemoryAudit<D> {
  const stepStart = Date.now();
  const resolved = resolveSignalEffects(signals);
  const fallbackNonSpendAction = AGENT_ACTION_POLICY[event.agent].nonSpendFallbackAction as D["action"];

  // The memory arm's resolved cap flows INTO the shared clamping logic rather
  // than being applied separately, so the ceiling is enforced in one place.
  const universal = enforceUniversalPolicy(decision, {
    agent: event.agent,
    eventAmount: event.amount,
    capPercent: resolved.discountCapPercent,
  });
  const afterUniversal = universal.decision;

  const mustBlockDiscount = resolved.blocksDiscount && afterUniversal.committed_spend_paise != null;
  const mustEscalate = resolved.forcesEscalation && !afterUniversal.escalate_to_human;

  const notes = [...universal.notes];
  const triggeredBy = new Set<string>(universal.triggeredBy);
  if (mustBlockDiscount) {
    notes.push(`spend blocked by: ${resolved.blockingSignals.join(", ")}`);
    for (const id of resolved.blockingSignals) triggeredBy.add(id);
  }
  if (mustEscalate) {
    notes.push(`escalation forced by: ${resolved.escalatingSignals.join(", ")}`);
    for (const id of resolved.escalatingSignals) triggeredBy.add(id);
  }
  if (universal.triggeredBy.includes("spend_ceiling") && resolved.cappingSignal) {
    triggeredBy.add(resolved.cappingSignal);
  }

  const unsupported = unsupportedFactorCitations(decision.memory_factors_used, signals);

  if (notes.length === 0) {
    return {
      ...afterUniversal,
      escalation_reason: normalizeEscalationReason(
        afterUniversal.escalate_to_human,
        afterUniversal.escalation_reason,
      ),
      signals,
      policy_override: null,
      unsupported_factor_citations: unsupported,
    };
  }

  const notesJoined = notes.join("; ");
  emitTrace(
    { ...traceBase, stepOrder },
    "policy_override",
    `${notesJoined}; pre_override_committed_spend_paise: ${decision.committed_spend_paise ?? "null"}`,
    Date.now() - stepStart,
  );

  const escalated = mustBlockDiscount || mustEscalate ? true : afterUniversal.escalate_to_human;
  // True only when policy escalated a decision the model did not escalate.
  const forcedEscalation = escalated && !decision.escalate_to_human;

  return {
    ...afterUniversal,
    action: mustBlockDiscount ? fallbackNonSpendAction : afterUniversal.action,
    committed_spend_paise: mustBlockDiscount ? null : afterUniversal.committed_spend_paise,
    // Capping alone does not force escalation — the decision still stands, it
    // is just priced within policy.
    escalate_to_human: escalated,
    // When policy is what forced the escalation, the reason is policy — not
    // whatever the model said (or failed to say) when it did not intend to
    // escalate at all.
    escalation_reason: forcedEscalation
      ? "policy_constraint"
      : normalizeEscalationReason(escalated, afterUniversal.escalation_reason),
    reasoning: `${decision.reasoning}\n\n[POLICY OVERRIDE] ${notesJoined}.`,
    signals,
    policy_override: {
      original_action: decision.action,
      original_committed_spend_paise: decision.committed_spend_paise,
      original_escalate_to_human: decision.escalate_to_human,
      triggered_by: [...triggeredBy],
      notes: notesJoined,
      escalation_reason_forced: forcedEscalation,
    },
    unsupported_factor_citations: unsupported,
  };
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
