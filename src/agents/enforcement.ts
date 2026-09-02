// THE UNIVERSAL POLICY LAYER — the standing business rules any production
// deployment would have, memory or not. It runs on BOTH arms, identically.
//
// Why both arms: before this existed, the baseline called decide() and returned
// raw model output with no enforcement at all, while the memory arm had a
// code-enforced ceiling. That was a safety gap, but worse, it was a CONFOUND —
// any measured "memory saved money" partly reflected the mere existence of a
// guardrail rather than anything memory contributed. With the universal layer
// shared, the remaining gap between arms is what memory actually contributes.
//
// The split is:
//   UNIVERSAL (here)      — spend bounds, action/spend coherence, and a default
//                           ceiling. Both arms.
//   MEMORY-DERIVED (enforcePolicy in memoryContext.ts) — tightened caps,
//                           blocks, and forced escalation from
//                           resolveSignalEffects(). Memory arm only.
//
// The memory arm passes its (possibly tighter) resolved cap into this function
// rather than clamping separately, so the clamping logic exists exactly once.
import type Database from "better-sqlite3";
import type { PolicyOverrideRecord } from "../memory/profile.js";
import { AGENT_ACTION_POLICY } from "./schema.js";
import { DEFAULT_DISCOUNT_CAP_PERCENT } from "./signals/thresholds.js";
import { clearTrace, emitTrace, guardrailPayload, toTracedDecision } from "./trace.js";
import type { AgentType } from "../types/index.js";

export interface EnforceableDecision {
  reasoning: string;
  memory_factors_used: string[];
  action: string;
  committed_spend_paise: number | null;
  escalate_to_human: boolean;
  escalation_reason: string | null;
}

export interface UniversalPolicyResult<D> {
  decision: D;
  notes: string[];
  // Registry signal ids are not involved at this layer; these are rule names.
  triggeredBy: string[];
}

// The ceiling in paise, guarded against a zero or missing event amount. The
// `noise` scenario plants a zero-value cart, where floor(0 * pct / 100) is 0 —
// so without the zero-spend rule below the guardrail itself would manufacture a
// worthless discount_usage row.
export function spendCeilingPaise(eventAmount: number, capPercent: number): number {
  if (!Number.isFinite(eventAmount) || eventAmount <= 0) return 0;
  return Math.floor((eventAmount * capPercent) / 100);
}

export interface UniversalPolicyOptions {
  agent: AgentType;
  eventAmount: number;
  // Defaults to the standing ceiling. The memory arm passes its resolved cap,
  // which may be tighter (a brake) or wider (provenPayer).
  capPercent?: number;
}

// ORDER IS LOAD-BEARING, and specifically coherence must run BEFORE any block
// logic downstream. The memory arm's block rule swaps the action to a non-spend
// fallback whenever it removes spend; if an incoherent `no_action` + spend
// reached that rule with its spend intact, the guardrail would swap the action
// to send_reminder and ADD an outbound message the model never asked to send.
// Nulling incoherent spend here makes that unreachable.
export function enforceUniversalPolicy<D extends EnforceableDecision>(
  decision: D,
  options: UniversalPolicyOptions,
): UniversalPolicyResult<D> {
  const policy = AGENT_ACTION_POLICY[options.agent];
  const capPercent = options.capPercent ?? DEFAULT_DISCOUNT_CAP_PERCENT;
  const ceiling = spendCeilingPaise(options.eventAmount, capPercent);

  const notes: string[] = [];
  const triggeredBy: string[] = [];
  let spend = decision.committed_spend_paise;
  let action = decision.action;

  // 1. NEGATIVE SPEND is a malformed output, not a decision. It would slip past
  //    the ceiling check (it is below it), reduce measured spend, and inflate
  //    net revenue in the comparison. Reject outright and shout.
  if (spend != null && spend < 0) {
    console.error(
      `  !! MALFORMED OUTPUT: ${options.agent} returned committed_spend_paise=${spend} (negative). Treating as no spend.`,
    );
    notes.push(`negative spend (${spend}) rejected as malformed`);
    triggeredBy.push("negative_spend_rejected");
    spend = null;
  }

  // 2. COHERENCE: spend attached to an action that cannot carry it. Keep the
  //    action the model chose — it is the spend that is wrong, not the intent —
  //    and drop the spend.
  if (spend != null && !policy.spendableActions.includes(action)) {
    notes.push(`action "${action}" cannot carry spend; committed_spend_paise dropped`);
    triggeredBy.push("action_spend_incoherent");
    spend = null;
  }

  // 3. CEILING. Applies to both arms; the memory arm may have supplied a
  //    tighter percentage.
  if (spend != null && spend > ceiling) {
    notes.push(`spend clamped to the ${capPercent}% ceiling (${ceiling} paise)`);
    triggeredBy.push("spend_ceiling");
    spend = ceiling;
  }

  // 4. ZERO SPEND is not a discount. Writing it would create a worthless
  //    discount_usage row that still increments the stopping-rule counter,
  //    pushing a customer toward a gaming flag on the strength of a discount
  //    that does not exist. Fall back to the agent's non-spend action, since a
  //    "send_discount" worth nothing is not a coherent thing to send.
  if (spend != null && spend === 0) {
    notes.push(`zero spend is not a discount; action "${action}" -> "${policy.nonSpendFallbackAction}"`);
    triggeredBy.push("zero_spend_rejected");
    spend = null;
    if (policy.spendableActions.includes(action)) action = policy.nonSpendFallbackAction;
  }

  return {
    decision: { ...decision, action, committed_spend_paise: spend },
    notes,
    triggeredBy,
  };
}

// escalate_to_human and escalation_reason must agree: a reason without an
// escalation is noise, an escalation without a reason is an unexplained
// handoff. Normalised deterministically rather than by a zod .refine(), because
// a refinement failure under constrained decoding costs a whole retry call to
// fix what is a one-line coercion.
export function normalizeEscalationReason(escalated: boolean, reason: string | null): string | null {
  if (!escalated) return null;
  return reason ?? "ambiguous_case";
}

// Baseline-arm enforcement, in ONE implementation with two entry points.
//
// applyBaselinePolicy is the pure, database-free core (what the tests exercise);
// applyBaselinePolicyWithTrace wraps it with the two trace rows a replay needs.
// They share this function rather than each building the override record,
// because two copies of "what did policy change" is precisely how the recorded
// override and the recorded decision would drift apart.
interface BaselinePolicyResult<D> {
  decision: D & { policy_override: PolicyOverrideRecord | null };
  notes: string[];
  triggeredBy: string[];
  capPercent: number;
}

function applyBaselinePolicyDetailed<D extends EnforceableDecision>(
  raw: D,
  options: UniversalPolicyOptions,
): BaselinePolicyResult<D> {
  const result = enforceUniversalPolicy(raw, options);
  const escalated = result.decision.escalate_to_human;
  const normalized = {
    ...result.decision,
    escalation_reason: normalizeEscalationReason(escalated, result.decision.escalation_reason),
  };
  const capPercent = options.capPercent ?? DEFAULT_DISCOUNT_CAP_PERCENT;

  if (result.notes.length === 0) {
    return {
      decision: { ...normalized, policy_override: null },
      notes: result.notes,
      triggeredBy: result.triggeredBy,
      capPercent,
    };
  }

  const notesJoined = result.notes.join("; ");
  return {
    decision: {
      ...normalized,
      reasoning: `${normalized.reasoning}\n\n[POLICY OVERRIDE] ${notesJoined}.`,
      policy_override: {
        original_action: raw.action,
        original_committed_spend_paise: raw.committed_spend_paise,
        original_escalate_to_human: raw.escalate_to_human,
        triggered_by: result.triggeredBy,
        notes: notesJoined,
        escalation_reason_forced: false,
      },
    },
    notes: result.notes,
    triggeredBy: result.triggeredBy,
    capPercent,
  };
}

// Baseline-arm entry point: universal policy only, packaged with an override
// record so the runner records it exactly as it does for the memory arm.
// A baseline override row carries no `signals` value, which is coherent —
// baseline has no memory from which to compute them.
export function applyBaselinePolicy<D extends EnforceableDecision>(
  decision: D,
  options: UniversalPolicyOptions,
): D & { policy_override: PolicyOverrideRecord | null } {
  return applyBaselinePolicyDetailed(decision, options).decision;
}

// BASELINE ARM, GUARDRAIL + TRACE IN ONE STEP.
//
// The baseline used to emit a single "agent_reasoning" trace row and nothing
// else, so its guardrail was invisible: a replay of a baseline decision could
// show what the model said and what was ultimately recorded, with no way to see
// whether anything had been enforced in between. That asymmetry also made the
// two arms non-comparable in a replay UI, since only one of them had a
// guardrail step to render.
//
// Both trace rows are written here rather than in each agent module because all
// three baseline agents did the identical thing, and three copies of a step
// sequence is exactly how the arms drift apart.
export function applyBaselinePolicyWithTrace<D extends EnforceableDecision>(
  raw: D,
  options: UniversalPolicyOptions & {
    db: Database.Database;
    customerId: string;
    eventId: string;
    // Milliseconds spent in the model call that produced `raw`. Measured by the
    // caller, since only it knows when the call started.
    modelDurationMs: number;
  },
): D & { policy_override: PolicyOverrideRecord | null } {
  const { db, customerId, eventId, modelDurationMs, ...policyOptions } = options;
  const guardrailStart = Date.now();
  const result = applyBaselinePolicyDetailed(raw, policyOptions);

  const traceBase = { db, customerId, eventId, agent: options.agent, mode: "baseline" as const };
  clearTrace(db, { eventId, mode: "baseline" });

  emitTrace(
    { ...traceBase, stepOrder: 1 },
    "agent_reasoning",
    { summary: raw.reasoning, decision: toTracedDecision(raw) },
    modelDurationMs,
  );

  emitTrace(
    { ...traceBase, stepOrder: 2 },
    "policy_override",
    guardrailPayload({
      applied: result.notes.length > 0,
      proposed: toTracedDecision(raw),
      final: toTracedDecision(result.decision),
      capPercent: result.capPercent,
      capPaise: spendCeilingPaise(policyOptions.eventAmount, result.capPercent),
      eventAmount: policyOptions.eventAmount,
      // Null, and meaningfully so: the baseline's ceiling is the standing
      // default, not something a memory signal set.
      cappingSignal: null,
      notes: result.notes,
      triggeredBy: result.triggeredBy,
    }),
    Date.now() - guardrailStart,
  );

  return result.decision;
}
