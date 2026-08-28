import type Database from "better-sqlite3";
import type {
  AgentType,
  AuditEntryType,
  AuditLogEntry,
  CustomerMemoryProfile,
  DiscountUsageRecord,
  DisputeBreakdown,
  RecoveryFrequencyRecord,
} from "../types/index.js";

// What the model originally asked for, and which signals overrode it.
// Recorded on the decision's audit row so "the LLM proposes, deterministic
// code disposes" is a query, not a claim.
export interface PolicyOverrideRecord {
  original_action: string;
  original_discount_amount: number | null;
  original_escalate_to_human: boolean;
  triggered_by: string[];
  notes: string;
}

export interface AppendAuditLogInput {
  customer_id: string;
  agent: AgentType | "system";
  entry_type: AuditEntryType;
  action: string;
  reasoning: string;
  mode?: "baseline" | "memory";
  event_id?: string;
  // Null on a memory_read row — reading memory decides nothing.
  escalate_to_human?: boolean;
  // Snapshot of the MemorySignals this decision was made against. Absent on
  // memory_read rows (signals are computed after the read) and on every
  // baseline row (which has no memory to compute signals from).
  signals?: object;
  policyOverride?: PolicyOverrideRecord | null;
  metadata?: Record<string, unknown>;
  timestamp?: string;
}

export function appendAuditLog(db: Database.Database, entry: AppendAuditLogInput): void {
  db.prepare(
    `INSERT INTO audit_log
       (timestamp, customer_id, agent, mode, entry_type, event_id, action, reasoning,
        escalate_to_human, signals, policy_override, metadata)
     VALUES (@timestamp, @customer_id, @agent, @mode, @entry_type, @event_id, @action, @reasoning,
             @escalate_to_human, @signals, @policy_override, @metadata)`,
  ).run({
    timestamp: entry.timestamp ?? new Date().toISOString(),
    customer_id: entry.customer_id,
    agent: entry.agent,
    mode: entry.mode ?? null,
    entry_type: entry.entry_type,
    event_id: entry.event_id ?? null,
    action: entry.action,
    reasoning: entry.reasoning,
    escalate_to_human: entry.escalate_to_human == null ? null : entry.escalate_to_human ? 1 : 0,
    signals: entry.signals ? JSON.stringify(entry.signals) : null,
    policy_override: entry.policyOverride ? JSON.stringify(entry.policyOverride) : null,
    metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
  });
}

export interface RecordDiscountUsageInput {
  customer_id: string;
  agent: AgentType;
  // Scopes this discount to one comparison run — see schema.sql's note on
  // discount_usage. Must match the mode of the run recording it.
  mode: "baseline" | "memory";
  amount: number;
  // The triggering event's id in its own table. Always present — order_id
  // below is cart-only.
  event_id: string;
  order_id?: string;
  timestamp?: string;
}

export function recordDiscountUsage(db: Database.Database, input: RecordDiscountUsageInput): void {
  db.prepare(
    `INSERT INTO discount_usage (customer_id, agent, mode, amount, event_id, order_id, timestamp)
     VALUES (@customer_id, @agent, @mode, @amount, @event_id, @order_id, @timestamp)`,
  ).run({
    customer_id: input.customer_id,
    agent: input.agent,
    mode: input.mode,
    amount: input.amount,
    event_id: input.event_id,
    order_id: input.order_id ?? null,
    timestamp: input.timestamp ?? new Date().toISOString(),
  });
}

// Scoped to `mode` — a memory-informed read must never see discounts the
// baseline run granted (or vice versa); the two runs are independent
// hypotheticals over the same event batch, not one real timeline.
function readDiscountUsageHistory(
  db: Database.Database,
  customerId: string,
  mode: "baseline" | "memory",
): DiscountUsageRecord[] {
  const rows = db
    .prepare(
      `SELECT agent, amount, event_id, order_id, timestamp FROM discount_usage
       WHERE customer_id = ? AND mode = ? ORDER BY timestamp ASC`,
    )
    .all(customerId, mode) as {
    agent: AgentType;
    amount: number;
    event_id: string;
    order_id: string | null;
    timestamp: string;
  }[];

  return rows.map((r) => ({
    agent: r.agent,
    amount: r.amount,
    event_id: r.event_id,
    order_id: r.order_id ?? "",
    timestamp: r.timestamp,
  }));
}

interface WindowAgg {
  count: number;
  window_start: string;
  window_end: string;
}

function aggWindow(db: Database.Database, sql: string, customerId: string, asOf?: string): WindowAgg | null {
  const row = db.prepare(sql).get(...(asOf ? [customerId, asOf] : [customerId])) as
    | { count: number; window_start: string | null; window_end: string | null }
    | undefined;
  if (!row || row.count === 0 || !row.window_start || !row.window_end) return null;
  return { count: row.count, window_start: row.window_start, window_end: row.window_end };
}

// recovery_frequency only lists agents with at least one qualifying event —
// a window with zero events has no meaningful start/end.
//
// `asOf`, when given, restricts every query to events at or before that
// timestamp. This is what makes the profile causal: without it, a customer's
// very first event would already see the count of ALL their eventual repeat
// events (including ones that haven't happened yet), so gaming detection
// would fire on event #1 instead of only once 3+ prior occurrences are real.
function readRecoveryFrequency(db: Database.Database, customerId: string, asOf?: string): RecoveryFrequencyRecord[] {
  const records: RecoveryFrequencyRecord[] = [];

  const cart = aggWindow(
    db,
    `SELECT COUNT(*) AS count, MIN(created_at) AS window_start, MAX(created_at) AS window_end
     FROM cart_abandonment_events WHERE customer_id = ? AND status != 'paid' ${asOf ? "AND created_at <= ?" : ""}`,
    customerId,
    asOf,
  );
  if (cart) records.push({ agent: "cart_abandonment", ...cart });

  const subscription = aggWindow(
    db,
    `SELECT COUNT(*) AS count, MIN(created_at) AS window_start, MAX(created_at) AS window_end
     FROM subscription_failure_events WHERE customer_id = ? AND status IN ('failed', 'halted') ${asOf ? "AND created_at <= ?" : ""}`,
    customerId,
    asOf,
  );
  if (subscription) records.push({ agent: "subscription_recovery", ...subscription });

  const dispute = aggWindow(
    db,
    `SELECT COUNT(*) AS count, MIN(dispute_created_at) AS window_start, MAX(dispute_created_at) AS window_end
     FROM dispute_events WHERE customer_id = ? ${asOf ? "AND dispute_created_at <= ?" : ""}`,
    customerId,
    asOf,
  );
  if (dispute) records.push({ agent: "dispute_responder", ...dispute });

  return records;
}

interface DisputeStats {
  count: number;
  totalAmount: number;
  breakdown: DisputeBreakdown;
  adverseAmount: number;
}

// Two independent asOf cutoffs, and the distinction between them is the whole
// point of this function:
//
//   VISIBLE  = dispute_created_at <= asOf   (the customer filed it)
//   RESOLVED = resolved_at IS NOT NULL AND resolved_at <= asOf
//
// A visible-but-unresolved dispute counts as `unresolved` NO MATTER what its
// stored `status` says. The stored status is the eventual truth; at this
// point in time it has not happened yet, and reading it would leak a future
// ruling backwards into a past decision — the same temporal-leakage bug class
// the asOf profile exists to prevent.
//
// Outcome mapping once resolved: `won` is evidence about the MERCHANT (they
// failed to deliver and lost the chargeback), never about the customer, so it
// drives no caution at all. `lost` is adverse. `closed` is neither: it
// generally means withdrawn or ended without a ruling, so penalising it would
// charge the customer for a decision nobody made.
function readDisputeStats(db: Database.Database, customerId: string, asOf?: string): DisputeStats {
  // Named parameters, not positional: the resolved-at cutoff is repeated in
  // five CASE expressions plus the WHERE clause, and counting `?` placeholders
  // across that is exactly the kind of thing that silently binds the wrong
  // value later.
  const visibleClause = asOf ? "AND dispute_created_at <= @asOf" : "";
  // When unscoped (the dashboard's "final state" read) any non-null
  // resolved_at counts as resolved.
  const resolved = asOf ? "(resolved_at IS NOT NULL AND resolved_at <= @asOf)" : "(resolved_at IS NOT NULL)";

  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS count,
         COALESCE(SUM(amount), 0) AS total,
         SUM(CASE WHEN NOT ${resolved} THEN 1 ELSE 0 END) AS unresolved,
         SUM(CASE WHEN ${resolved} AND status = 'won' THEN 1 ELSE 0 END) AS won,
         SUM(CASE WHEN ${resolved} AND status = 'lost' THEN 1 ELSE 0 END) AS adverse,
         SUM(CASE WHEN ${resolved} AND status = 'closed' THEN 1 ELSE 0 END) AS closed_undetermined,
         COALESCE(SUM(CASE WHEN ${resolved} AND status = 'lost' THEN amount ELSE 0 END), 0) AS adverse_amount
       FROM dispute_events
       WHERE customer_id = @customerId ${visibleClause}`,
    )
    .get(asOf ? { customerId, asOf } : { customerId }) as {
    count: number;
    total: number;
    // SUM() over zero rows is NULL in SQLite, so these are nullable even
    // though every non-empty result is an integer.
    unresolved: number | null;
    won: number | null;
    adverse: number | null;
    closed_undetermined: number | null;
    adverse_amount: number;
  };

  return {
    count: row.count,
    totalAmount: row.total,
    breakdown: {
      unresolved: row.unresolved ?? 0,
      won: row.won ?? 0,
      adverse: row.adverse ?? 0,
      closed_undetermined: row.closed_undetermined ?? 0,
    },
    adverseAmount: row.adverse_amount,
  };
}

// Heuristic, not a model: starts at 100 and subtracts per unresolved-risk
// event, weighted by how costly that risk is to the business (a dispute
// costs more than one abandoned cart). Tune these weights against the
// baseline-vs-memory comparison once that's running, not in the abstract.
//
// The dispute term is split by outcome rather than counting every filed
// dispute equally. A customer who complained and WON is not a risk — that
// dispute says the merchant failed to deliver — so it carries no penalty at
// all. An adverse (lost) dispute carries the full weight; a dispute still
// unresolved as of this read carries half, reflecting genuine uncertainty
// rather than established fault. `closed` disputes ended with no ruling
// either way and carry nothing.
const HEALTH_WEIGHTS = {
  adverseDisputePenalty: 12,
  unresolvedDisputePenalty: 6,
  failedSubscriptionCyclePenalty: 6,
  abandonedCartPenalty: 3,
};

function computeRollingHealthScore(
  db: Database.Database,
  customerId: string,
  breakdown: DisputeBreakdown,
  asOf?: string,
): number {
  const failedCycles = (
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM subscription_failure_events
         WHERE customer_id = ? AND status IN ('failed', 'halted') ${asOf ? "AND created_at <= ?" : ""}`,
      )
      .get(...(asOf ? [customerId, asOf] : [customerId])) as { count: number }
  ).count;

  const abandonedCarts = (
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM cart_abandonment_events
         WHERE customer_id = ? AND status != 'paid' ${asOf ? "AND created_at <= ?" : ""}`,
      )
      .get(...(asOf ? [customerId, asOf] : [customerId])) as { count: number }
  ).count;

  const score =
    100 -
    breakdown.adverse * HEALTH_WEIGHTS.adverseDisputePenalty -
    breakdown.unresolved * HEALTH_WEIGHTS.unresolvedDisputePenalty -
    failedCycles * HEALTH_WEIGHTS.failedSubscriptionCyclePenalty -
    abandonedCarts * HEALTH_WEIGHTS.abandonedCartPenalty;

  return Math.max(0, Math.min(100, score));
}

// Scoped to (mode OR NULL) for the same reason as discount_usage — a
// memory-informed read must not see the baseline run's decisions as if they
// were its own history. NULL-mode rows (system-level, not agent decisions)
// are cross-cutting and always included.
function readAuditLog(db: Database.Database, customerId: string, mode: "baseline" | "memory"): AuditLogEntry[] {
  const rows = db
    .prepare(
      `SELECT timestamp, agent, entry_type, action, reasoning FROM audit_log
       WHERE customer_id = ? AND (mode = ? OR mode IS NULL) ORDER BY timestamp ASC`,
    )
    .all(customerId, mode) as AuditLogEntry[];
  return rows;
}

// Pure — no audit_log side effect. Use this for read-only inspection (the
// dashboard API, ad-hoc queries); use getMemoryProfile below when an agent
// is actually consulting memory as part of making a decision, since that
// read itself is graded audit-trail material.
//
// `asOf` (ISO timestamp), when given, restricts dispute/recovery/health
// computation to events at or before that point — pass the triggering
// event's own timestamp so a decision only ever sees its own past, never
// events that haven't happened yet. Omit it for a "final state" read (the
// dashboard's overview of the whole batch).
export function computeMemoryProfile(
  db: Database.Database,
  customerId: string,
  mode: "baseline" | "memory",
  asOf?: string,
): CustomerMemoryProfile {
  const disputes = readDisputeStats(db, customerId, asOf);

  return {
    customer_id: customerId,
    dispute_count: disputes.count,
    total_disputed_amount: disputes.totalAmount,
    dispute_breakdown: disputes.breakdown,
    adverse_disputed_amount: disputes.adverseAmount,
    discount_usage_history: readDiscountUsageHistory(db, customerId, mode),
    recovery_frequency: readRecoveryFrequency(db, customerId, asOf),
    rolling_health_score: computeRollingHealthScore(db, customerId, disputes.breakdown, asOf),
    audit_log: readAuditLog(db, customerId, mode),
  };
}

export interface GetMemoryProfileOptions {
  // Which agent is asking, and in what mode — logged on the read itself so
  // the audit trail shows who consulted memory before deciding, per
  // CLAUDE.md's "log what it read from memory, and why" requirement. Also
  // scopes discount_usage_history/audit_log so this run only sees its own
  // mode's prior decisions, never the other comparison run's.
  requestedBy: AgentType | "system";
  mode: "baseline" | "memory";
  reason: string;
  // The triggering event's own timestamp — see computeMemoryProfile's asOf.
  asOf: string;
  // The triggering event's own id, so a memory_read row joins to the decision
  // row it preceded.
  eventId?: string;
}

export function getMemoryProfile(
  db: Database.Database,
  customerId: string,
  options: GetMemoryProfileOptions,
): CustomerMemoryProfile {
  const profile = computeMemoryProfile(db, customerId, options.mode, options.asOf);

  appendAuditLog(db, {
    customer_id: customerId,
    agent: options.requestedBy,
    mode: options.mode,
    entry_type: "memory_read",
    event_id: options.eventId,
    action: "read_memory_profile",
    reasoning: options.reason,
    metadata: {
      dispute_count: profile.dispute_count,
      dispute_breakdown: profile.dispute_breakdown,
      rolling_health_score: profile.rolling_health_score,
    },
  });

  return profile;
}
