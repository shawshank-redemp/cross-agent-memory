import type Database from "better-sqlite3";
import type { z } from "zod";
import { getMemoryProfile, type PolicyOverrideRecord } from "../memory/profile.js";
import type { MemoryProfilePayload } from "./memoryPayloadKeys.js";
import { MEMORY_PROFILE_EMITTABLE_KEYS, MEMORY_PROFILE_GLOSSARY } from "./memoryPayloadKeys.js";
import {
  claimForcedEscalation,
  enforceUniversalPolicy,
  normalizeEscalationReason,
  spendCeilingPaise,
} from "./enforcement.js";
import { AGENT_ACTION_POLICY } from "./schema.js";
import { withClosingInstruction } from "./objective.js";
import { SIGNAL_REGISTRY } from "./signals/registry.js";
import type { AgentType, Customer, CustomerMemoryProfile } from "../types/index.js";
import { decide } from "./claudeClient.js";
import { SIGNAL_DEFINITIONS } from "./signals/definitions.js";
import type { AnySignalDefinition } from "./signals/types.js";
import {
  buildSignalsBlock,
  computeMemorySignals,
  resolveSignalEffects,
  signalIsActive,
  summarizeActiveSignals,
  type MemorySignals,
  type SignalId,
  type TriggeringEventFacts,
} from "./policy.js";
import {
  clearTrace,
  emitTrace,
  guardrailPayload,
  toTracedDecision,
  type TraceContext,
} from "./trace.js";

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
// THE STABLE HALF OF THE SYSTEM PROMPT.
//
// Nothing here varies by customer, which is the whole point. Previously 62% of
// the system prompt (2,056 of 3,329 characters) was this customer's signal
// findings, so no two requests shared a prefix past the first third and prompt
// caching — a prefix match over tools -> system -> messages — could never fire.
// Per-case content now lives in the user message where it belongs.
//
// The field list is GENERATED from MEMORY_PROFILE_GLOSSARY, which is typed
// against the same key constant the payload is built from, so the prompt cannot
// describe a field we do not send or omit one we do. It did both before.
export function buildMemoryGlossaryBlock(): string {
  const lines = MEMORY_PROFILE_EMITTABLE_KEYS.map((k) => `- ${k}: ${MEMORY_PROFILE_GLOSSARY[k]}`);
  return `
You also have this customer's shared memory profile, aggregated across ALL
of Razorpay's recovery agents (Cart Abandonment, Subscription Recovery,
Dispute Responder) — not just your own agent's past interactions with them.

MEMORY FIELDS:
${lines.join("\n")}

POLICY SIGNALS: alongside the raw facts you receive a signals block. Each line
states what was MEASURED about this customer — counts, amounts, and the
threshold each is judged against — and, where policy acts on it, what that
means for what you may do. A signal that is nowhere near its threshold is
reported too: "1 payment, ₹450 lifetime" is a fact about this customer, not an
absence of one.

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

// The memory step's payload. The prose summary that used to be this whole
// value is kept as `summary`; everything a UI needs to render the read is
// alongside it as structured fields, so nothing has to be recovered by parsing
// a sentence.
//
// This is the profile AS OF the triggering event, which is the only version
// that means anything — it is what the decision was actually made against.
function profileTracePayload(profile: CustomerMemoryProfile, asOf: string) {
  const entries = profile.discount_usage_history.length;
  const b = profile.dispute_breakdown;
  return {
    summary: [
      `dispute_count: ${profile.dispute_count}`,
      `disputes(unresolved/merchant_conceded/customer_adverse/closed): ${b.unresolved}/${b.merchant_conceded}/${b.customer_adverse}/${b.closed_undetermined}`,
      `recovery_activity: ${profile.recovery_activity.by_agent.length} agents`,
      `discount_history: ${entries} entr${entries === 1 ? "y" : "ies"}`,
    ].join(", "),
    as_of: asOf,
    profile: {
      dispute_count: profile.dispute_count,
      total_disputed_amount: profile.total_disputed_amount,
      dispute_breakdown: profile.dispute_breakdown,
      adverse_disputed_amount: profile.adverse_disputed_amount,
      unresolved_dispute_reasons: profile.unresolved_dispute_reasons,
      discount_usage_history: profile.discount_usage_history,
      recovery_activity: profile.recovery_activity,
      intervention_outcomes: profile.intervention_outcomes,
      successful_payment_count: profile.successful_payment_count,
      total_paid_amount: profile.total_paid_amount,
    },
  };
}

// The signals step's payload. Carries EVERY registered signal, not just the
// active ones, because "this brake did not fire" is exactly as much a part of
// the decision's justification as "this one did" — a replay that showed only
// what fired could not distinguish a signal that stayed silent from one that
// does not exist. `kind` and `scope` come off the registry so a newly
// registered signal appears here with no edit.
function signalsTracePayload(signals: MemorySignals, eventAmountPaise: number) {
  const registry = Object.values(SIGNAL_DEFINITIONS) as AnySignalDefinition[];
  const evaluated = registry.map((def) => {
    const value = (signals as Record<string, unknown>)[def.id];
    return {
      id: def.id,
      kind: def.kind,
      scope: def.scope,
      value: value as unknown,
      // ACTIVE means it changes what the agent may do, read off effects() — the
      // same test resolveSignalEffects uses, so trace and enforcement agree.
      active: signalIsActive(def, value),
      effects: def.effects(value),
    };
  });
  return {
    summary: summarizeActiveSignals(signals),
    signals: signals as unknown as Record<string, unknown>,
    evaluated,
    // Same amount the decision resolves against, so the replay cannot show a
    // different escalation verdict than the one that was acted on.
    resolved: resolveSignalEffects(signals, eventAmountPaise),
  };
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
//   recovery_activity is not sent at all: every question the model would ask
//   of it is already answered by a signal (gaming, cross-agent gaming,
//   composite churn), and the raw event list is long.
//
//   rolling_health_score is no longer sent. It subtracts a fixed penalty per
//   event with no view of recency or density, so it measures event VOLUME
//   rather than risk — measured on the committed batch it rated the
//   churn_signal cohort (median 91) healthier than repeat_offender_cart (88).
//   The model already receives the counts it is built from, so a summary that
//   argues the wrong way on the highest-risk group is worse than none. It stays
//   on the profile for the dashboard.
//   dispute_breakdown and unresolved_dispute_reasons are dropped only when a
//   dispute caution level is already stated in prose, since in that case the
//   prose says what they would say. The two AMOUNT fields
//   (total_disputed_amount, adverse_disputed_amount) are always kept — a small
//   dispute and a large one are different facts that no signal captures.
//
// Returns the key lists alongside the content because WHICH keys were sent is
// per-call information the request string alone does not expose without
// re-parsing it, and the replay trace needs it. Derived from the objects
// actually serialised below, never from a second hand-written list — a list
// that could disagree with the payload would be worse than no list.
interface BuiltRequest {
  content: string;
  memoryProfileKeys: string[];
  policySignalsKeys: string[];
}

function buildUserContent(
  customer: Customer,
  event: unknown,
  profile: CustomerMemoryProfile,
  signals: MemorySignals,
  signalsBlock: string,
): BuiltRequest {
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
    discount_usage_history: profile.discount_usage_history,
    // The feedback loop. discount_usage_history says what we GRANTED; this says
    // whether it WORKED. Without it an agent on its fourth decision about a
    // customer can only see that it kept trying, never that trying kept
    // failing.
    intervention_outcomes: profile.intervention_outcomes,
    recent_decisions: recentDecisions,
    // Always sent, even when a caution level is stated in prose — especially
    // then. The prose says a dispute went against this customer; only this says
    // whether that was for a trivial sum or a ruinous one. See
    // memoryPayloadKeys.ts.
    adverse_disputed_amount: profile.adverse_disputed_amount,
  };
  if (!disputeStatedInProse) {
    memoryProfile.dispute_breakdown = profile.dispute_breakdown;
    memoryProfile.unresolved_dispute_reasons = profile.unresolved_dispute_reasons;
  }

  // The dispute_breakdown / unresolved_dispute_reasons condition above is
  // unchanged: they are what the caution level is DERIVED from, so once the
  // signals block states the level they would only restate it.
  const payload = JSON.stringify({ customer, event, memory_profile: memoryProfile }, null, 2);

  // EVERYTHING ABOUT THIS CASE NOW LIVES HERE, in the user message — the facts
  // and the signals block together. The signals block used to be split: prose in
  // the SYSTEM prompt for signals worth mentioning, a separate policy_signals
  // JSON object here for the rest. One concept, two formats, two locations, and
  // which half a signal landed in depended on its value.
  //
  // Data first, instruction last, as before.
  const content = withClosingInstruction(
    `${payload}\n\nSIGNALS (measured as of this event):\n${signalsBlock}`,
  );

  return {
    content,
    memoryProfileKeys: Object.keys(memoryProfile),
    policySignalsKeys: Object.keys(signals as Record<string, unknown>),
  };
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
  // The trace for this event+mode is rebuilt from scratch, so a re-decide
  // replaces the previous run's steps instead of interleaving with them.
  clearTrace(params.db, { eventId: params.eventId, mode: "memory" });

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
      profileTracePayload(profile, params.eventTimestamp),
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
      signalsTracePayload(signals, params.eventFacts.amount),
      Date.now() - stepStart,
    );
  } catch (err) {
    // The guardrail could not be evaluated. Do not call the model at all —
    // there is nothing to check its answer against.
    return failClosed(params, err);
  }

  stepStart = Date.now();
  const signalsBlock = buildSignalsBlock(signals, {
    profile,
    agent: params.agent,
    event: { ...params.eventFacts, agent: params.agent, timestamp: params.eventTimestamp },
  });
  const request = buildUserContent(params.customer, params.event, profile, signals, signalsBlock);
  const glossaryBlock = buildMemoryGlossaryBlock();
  stepOrder += 1;
  // WHAT WAS ACTUALLY SENT, recorded before the call rather than reconstructed
  // after it. The payload is trimmed per-decision — conditional profile keys are
  // dropped when the prose already states the finding, and policy_signals
  // carries only what the prose does not — so which keys went over is a fact
  // about THIS call that nothing else records.
  emitTrace(
    { ...traceBase, stepOrder },
    "model_request",
    {
      summary:
        `${request.memoryProfileKeys.length} memory_profile key(s), ` +
        `${request.policySignalsKeys.length} policy_signals key(s)`,
      memory_profile_keys: request.memoryProfileKeys,
      policy_signals_keys: request.policySignalsKeys,
      // The generated signal prose, verbatim. This is the half of the prompt
      // that varies by customer; the objective block is identical in both arms
      // by construction (see objective.ts) and is not repeated here.
      signal_prose: signalsBlock,
      policy_block_chars: glossaryBlock.length,
      user_content_chars: request.content.length,
    },
    Date.now() - stepStart,
  );

  stepStart = Date.now();
  const decision = await decide(
    `${params.systemPrompt}\n${glossaryBlock}`,
    request.content,
    params.schema,
  );
  stepOrder += 1;
  emitTrace(
    { ...traceBase, stepOrder },
    "agent_reasoning",
    // The RAW model output, before any guardrail. The guardrail step below
    // records the final decision, and the pair is what makes "the LLM proposes,
    // deterministic code disposes" visible rather than merely asserted.
    { summary: decision.reasoning, decision: toTracedDecision(decision) },
    Date.now() - stepStart,
  );

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
  const resolved = resolveSignalEffects(signals, event.amount);
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
  // Suppression outranks the block's reminder fallback: there is no point
  // swapping a discount for a message we have also decided not to send.
  //
  // GATED ON THE AGENT HAVING A "SEND NOTHING" OPTION AT ALL. disputeCautionLevel
  // is customer-scoped, so it fires for the Dispute Responder too — but that
  // agent is not reaching out to anybody. It is filing a defence with a bank,
  // and its actions are accept_dispute and contest_dispute. There is no
  // no_action in its enum, and "stop contacting this customer" is not a
  // coherent instruction for it.
  //
  // Without this gate the guardrail forced an action the agent cannot take: 11
  // dispute decisions in the 2026-09-05 run came back as no_action. Worse than
  // invalid, it is backwards — declining to contest a chargeback is how a
  // merchant loses one by default, so suppression there would forfeit the
  // disputed amount on exactly the customers already ruled against us.
  const canSendNothing = (AGENT_ACTION_POLICY[event.agent].actions as readonly string[]).includes("no_action");
  const mustSuppressOutreach =
    resolved.suppressesOutreach && canSendNothing && afterUniversal.action !== "no_action";
  // claimForcedEscalation() consumes one unit of the run's escalation budget, so
  // it must only be called when an escalation would actually be forced —
  // short-circuit order matters here. The breaker counts POLICY-forced
  // escalations only: a decision the model escalated of its own accord is its
  // judgment, not our rule firing, and a budget on our rules should not silence
  // it. See MAX_FORCED_ESCALATIONS_PER_RUN.
  const mustEscalate =
    resolved.forcesEscalation && !afterUniversal.escalate_to_human && claimForcedEscalation();

  const notes = [...universal.notes];
  const triggeredBy = new Set<string>(universal.triggeredBy);
  if (mustSuppressOutreach) {
    notes.push(`outreach suppressed by: ${resolved.blockingSignals.join(", ")}`);
    for (const id of resolved.blockingSignals) triggeredBy.add(id);
  }
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

  // ALWAYS EMITTED, including when policy changed nothing.
  //
  // This row used to be written only when `notes` was non-empty, which made two
  // opposite outcomes look identical from the outside: "the guardrail ran and
  // found nothing to correct" and "the guardrail never ran at all" were both an
  // absent row. A replay could then only ever show enforcement in the cases
  // where it intervened — exactly the cases where it is least surprising —
  // while the far more common clean pass left no evidence that anything had
  // been checked. `applied` is what carries that distinction now.
  const emitGuardrailTrace = (final: MemoryDecisionShape, applied: boolean): void => {
    emitTrace(
      { ...traceBase, stepOrder },
      "policy_override",
      guardrailPayload({
        applied,
        proposed: toTracedDecision(decision),
        final: toTracedDecision(final),
        capPercent: resolved.discountCapPercent,
        capPaise: spendCeilingPaise(event.amount, resolved.discountCapPercent),
        eventAmount: event.amount,
        cappingSignal: resolved.cappingSignal,
        blockingSignals: resolved.blockingSignals,
        escalatingSignals: resolved.escalatingSignals,
        notes,
        triggeredBy: [...triggeredBy],
      }),
      Date.now() - stepStart,
    );
  };

  if (notes.length === 0) {
    const untouched = {
      ...afterUniversal,
      escalation_reason: normalizeEscalationReason(
        afterUniversal.escalate_to_human,
        afterUniversal.escalation_reason,
      ),
    };
    emitGuardrailTrace(untouched, false);
    return {
      ...untouched,
      signals,
      policy_override: null,
      unsupported_factor_citations: unsupported,
    };
  }

  const notesJoined = notes.join("; ");
  // BLOCKING NO LONGER IMPLIES ESCALATING. This line is where the two were
  // welded together, and unwelding it was deferred to this stage on purpose —
  // it is guardrail code, not signal code.
  //
  // "Should we spend money here?" and "should a person look at this?" are
  // different questions. Fusing them meant every block also paged a human, and
  // measured on the batch that forced a handoff on 41.9% of ALL events — a rate
  // no merchant could staff. It also wrecked the measurement: the previous run
  // escalated 724 times against the baseline's 51, and because the outcome model
  // prices an escalation at a flat fee while crediting it with a discount's
  // conversion, essentially the entire reported revenue lift was a function of
  // handoff VOLUME rather than of any spending judgment memory contributed.
  //
  // Only a signal that explicitly declares forcesEscalation now escalates, which
  // after the signals rework is recentMultiDomainTrouble alone: a customer
  // failing across two domains in a fortnight is a genuine judgment call. A
  // customer who has simply used up their discount budget is not — that is
  // arithmetic, and the fallback is a free reminder rather than a person's time.
  const escalated = mustEscalate ? true : afterUniversal.escalate_to_human;
  // True only when policy escalated a decision the model did not escalate.
  const forcedEscalation = escalated && !decision.escalate_to_human;

  const final = {
    ...afterUniversal,
    action: mustSuppressOutreach
      ? ("no_action" as D["action"])
      : mustBlockDiscount
        ? fallbackNonSpendAction
        : afterUniversal.action,
    committed_spend_paise:
      mustSuppressOutreach || mustBlockDiscount ? null : afterUniversal.committed_spend_paise,
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
  };

  emitGuardrailTrace(final, true);

  return {
    ...final,
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
