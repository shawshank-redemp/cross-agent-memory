import type Database from "better-sqlite3";
import type { AgentType } from "../types/index.js";

export interface TraceContext {
  db: Database.Database;
  customerId: string;
  eventId: string;
  agent: AgentType;
  mode: "baseline" | "memory";
  stepOrder: number; // caller increments
}

// What a trace row's `detail` column carries.
//
// STRUCTURED JSON, NOT PROSE, and deliberately inside the EXISTING TEXT column
// rather than in a new one. `CREATE TABLE IF NOT EXISTS` cannot add a column to
// a table that already exists, so a new column would make openDb()'s
// assertSchemaIsCurrent throw on every database written before this change —
// and the only remedy that check offers is `rm -rf data/db`, which would
// discard a real, paid-for batch run's audit and trace rows. `detail` is
// unconstrained TEXT, so JSON goes in it at no schema cost.
//
// Every payload carries a `summary` string. That keeps each row readable on its
// own (the previous prose detail is still there, under a key) while the
// structured siblings are what a UI binds to. Readers that predate this change
// see JSON where they expected prose; readTraceDetail() below is the seam that
// tolerates both, because rows written by earlier runs are still plain strings.
//
// The explicit index signature is what lets a specifically-typed payload (see
// GuardrailTracePayload) satisfy this. TypeScript gives type ALIASES an
// implicit index signature but not interfaces, and these are interfaces because
// they are extended.
export interface TraceDetailBase {
  summary: string;
  [key: string]: unknown;
}

export type TraceDetail = string | TraceDetailBase;

// A decision exactly as the model returned it, before any guardrail ran. The
// UI's "model proposes" column binds to this, so it must be the RAW output —
// reading the post-enforcement decision back would make the proposed and final
// columns identical whenever policy changed something, which is precisely the
// case the column exists to show.
export interface TracedDecision {
  reasoning: string;
  memory_factors_used: string[];
  action: string;
  committed_spend_paise: number | null;
  escalate_to_human: boolean;
  escalation_reason: string | null;
}

export function emitTrace(
  ctx: TraceContext,
  stepName: string,
  detail: TraceDetail,
  durationMs: number,
): void {
  ctx.db
    .prepare(
      `INSERT INTO agent_trace_events (customer_id, event_id, agent, mode, step_order, step_name, detail, duration_ms, started_at)
     VALUES (@customer_id, @event_id, @agent, @mode, @step_order, @step_name, @detail, @duration_ms, @started_at)`,
    )
    .run({
      customer_id: ctx.customerId,
      event_id: ctx.eventId,
      agent: ctx.agent,
      mode: ctx.mode,
      step_order: ctx.stepOrder,
      step_name: stepName,
      detail: typeof detail === "string" ? detail : JSON.stringify(detail),
      duration_ms: durationMs,
      started_at: new Date().toISOString(),
    });
}

// IDEMPOTENCY for the trace table, done by clearing rather than by a unique
// index. Three reasons a plain index is the wrong tool here:
//
//   1. A BARE unique index would turn silent duplication into a hard mid-run
//      crash on the retry path — the same downgrade discount_usage's comment
//      warns about.
//   2. The committed database already contains six rows that violate
//      (event_id, mode, step_order): three events whose profile read and signal
//      evaluation were re-emitted when decide() retried. CREATE UNIQUE INDEX
//      would fail at openDb() on that data.
//   3. Step ORDER is not stable across versions. Adding a step shifts every
//      later step's number, so an upsert keyed on step_order would leave the
//      tail of a previous, longer trace stranded behind the new one.
//
// Clearing the whole (event_id, mode) slice at the start of a decision makes
// the stored trace exactly the last run's trace, with no stale tail.
export function clearTrace(
  db: Database.Database,
  scope: { eventId: string; mode: "baseline" | "memory" },
): void {
  db.prepare("DELETE FROM agent_trace_events WHERE event_id = ? AND mode = ?").run(scope.eventId, scope.mode);
}

// Parse a stored detail back. Rows written before the structured payload
// landed hold plain prose, so those come back as { summary } — the reader gets
// one shape either way and never has to branch on run vintage.
export function readTraceDetail(detail: string): TraceDetailBase & Record<string, unknown> {
  const trimmed = detail.trimStart();
  if (!trimmed.startsWith("{")) return { summary: detail };
  try {
    const parsed: unknown = JSON.parse(detail);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
          return { ...obj, summary: typeof obj.summary === "string" ? obj.summary : detail };
    }
  } catch {
    // Prose that merely happens to start with a brace. Fall through.
  }
  return { summary: detail };
}

// The guardrail step's payload, IDENTICAL IN SHAPE ACROSS BOTH ARMS so the UI
// binds one structure and the two are actually comparable. The arms differ only
// in what fills it: baseline resolves its cap from the standing default, the
// memory arm from resolveSignalEffects().
//
// ALWAYS EMITTED, including when nothing changed. It used to be written only
// when enforcePolicy had notes, which made "the guardrail found nothing to fix"
// indistinguishable from "the guardrail never ran" — the same absence for two
// opposite meanings. `applied` is what separates them now.
export interface GuardrailTracePayload extends TraceDetailBase {
  applied: boolean;
  proposed: TracedDecision;
  final: TracedDecision;
  // Percent of the event amount, and that percent resolved into paise.
  cap_percent: number;
  cap_paise: number;
  event_amount_paise: number;
  // Which registry signal set the winning cap, if any. Null on the baseline
  // arm, where the cap is the standing default rather than a signal's doing.
  capping_signal: string | null;
  blocking_signals: string[];
  escalating_signals: string[];
  notes: string[];
  triggered_by: string[];
}

export function guardrailPayload(input: {
  applied: boolean;
  proposed: TracedDecision;
  final: TracedDecision;
  capPercent: number;
  capPaise: number;
  eventAmount: number;
  cappingSignal?: string | null;
  blockingSignals?: string[];
  escalatingSignals?: string[];
  notes: string[];
  triggeredBy: string[];
}): GuardrailTracePayload {
  return {
    summary: input.applied
      ? input.notes.join("; ")
      : `no override: the model's decision already satisfied every rule (cap ${input.capPercent}% = ${input.capPaise} paise)`,
    applied: input.applied,
    proposed: input.proposed,
    final: input.final,
    cap_percent: input.capPercent,
    cap_paise: input.capPaise,
    event_amount_paise: input.eventAmount,
    capping_signal: input.cappingSignal ?? null,
    blocking_signals: input.blockingSignals ?? [],
    escalating_signals: input.escalatingSignals ?? [],
    notes: input.notes,
    triggered_by: input.triggeredBy,
  };
}

export function toTracedDecision(d: TracedDecision): TracedDecision {
  return {
    reasoning: d.reasoning,
    memory_factors_used: d.memory_factors_used,
    action: d.action,
    committed_spend_paise: d.committed_spend_paise,
    escalate_to_human: d.escalate_to_human,
    escalation_reason: d.escalation_reason,
  };
}
