import type Database from "better-sqlite3";
import type {
  AgentType,
  AuditLogEntry,
  CustomerMemoryProfile,
  DiscountUsageRecord,
  RecoveryFrequencyRecord,
} from "../types/index.js";

export interface AppendAuditLogInput {
  customer_id: string;
  agent: AgentType | "system";
  action: string;
  reasoning: string;
  mode?: "baseline" | "memory";
  metadata?: Record<string, unknown>;
  timestamp?: string;
}

export function appendAuditLog(db: Database.Database, entry: AppendAuditLogInput): void {
  db.prepare(
    `INSERT INTO audit_log (timestamp, customer_id, agent, mode, action, reasoning, metadata)
     VALUES (@timestamp, @customer_id, @agent, @mode, @action, @reasoning, @metadata)`,
  ).run({
    timestamp: entry.timestamp ?? new Date().toISOString(),
    customer_id: entry.customer_id,
    agent: entry.agent,
    mode: entry.mode ?? null,
    action: entry.action,
    reasoning: entry.reasoning,
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
  order_id?: string;
  timestamp?: string;
}

export function recordDiscountUsage(db: Database.Database, input: RecordDiscountUsageInput): void {
  db.prepare(
    `INSERT INTO discount_usage (customer_id, agent, mode, amount, order_id, timestamp)
     VALUES (@customer_id, @agent, @mode, @amount, @order_id, @timestamp)`,
  ).run({
    customer_id: input.customer_id,
    agent: input.agent,
    mode: input.mode,
    amount: input.amount,
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
      `SELECT agent, amount, order_id, timestamp FROM discount_usage
       WHERE customer_id = ? AND mode = ? ORDER BY timestamp ASC`,
    )
    .all(customerId, mode) as { agent: AgentType; amount: number; order_id: string | null; timestamp: string }[];

  return rows.map((r) => ({
    agent: r.agent,
    amount: r.amount,
    order_id: r.order_id ?? "",
    timestamp: r.timestamp,
  }));
}

interface WindowAgg {
  count: number;
  window_start: string;
  window_end: string;
}

function aggWindow(db: Database.Database, sql: string, customerId: string): WindowAgg | null {
  const row = db.prepare(sql).get(customerId) as
    | { count: number; window_start: string | null; window_end: string | null }
    | undefined;
  if (!row || row.count === 0 || !row.window_start || !row.window_end) return null;
  return { count: row.count, window_start: row.window_start, window_end: row.window_end };
}

// recovery_frequency only lists agents with at least one qualifying event —
// a window with zero events has no meaningful start/end.
function readRecoveryFrequency(db: Database.Database, customerId: string): RecoveryFrequencyRecord[] {
  const records: RecoveryFrequencyRecord[] = [];

  const cart = aggWindow(
    db,
    `SELECT COUNT(*) AS count, MIN(timestamp) AS window_start, MAX(timestamp) AS window_end
     FROM cart_abandonment_events WHERE customer_id = ? AND status != 'paid'`,
    customerId,
  );
  if (cart) records.push({ agent: "cart_abandonment", ...cart });

  const subscription = aggWindow(
    db,
    `SELECT COUNT(*) AS count, MIN(timestamp) AS window_start, MAX(timestamp) AS window_end
     FROM subscription_failure_events WHERE customer_id = ? AND status IN ('failed', 'halted')`,
    customerId,
  );
  if (subscription) records.push({ agent: "subscription_recovery", ...subscription });

  const dispute = aggWindow(
    db,
    `SELECT COUNT(*) AS count, MIN(dispute_created_at) AS window_start, MAX(dispute_created_at) AS window_end
     FROM dispute_events WHERE customer_id = ?`,
    customerId,
  );
  if (dispute) records.push({ agent: "dispute_responder", ...dispute });

  return records;
}

function readDisputeStats(db: Database.Database, customerId: string): { count: number; totalAmount: number } {
  const row = db
    .prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total FROM dispute_events WHERE customer_id = ?`)
    .get(customerId) as { count: number; total: number };
  return { count: row.count, totalAmount: row.total };
}

// Heuristic, not a model: starts at 100 and subtracts per unresolved-risk
// event, weighted by how costly that risk is to the business (a dispute
// costs more than one abandoned cart). Tune these weights against the
// baseline-vs-memory comparison once that's running, not in the abstract.
const HEALTH_WEIGHTS = {
  disputePenalty: 12,
  failedSubscriptionCyclePenalty: 6,
  abandonedCartPenalty: 3,
};

function computeRollingHealthScore(
  db: Database.Database,
  customerId: string,
  disputeCount: number,
): number {
  const failedCycles = (
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM subscription_failure_events
         WHERE customer_id = ? AND status IN ('failed', 'halted')`,
      )
      .get(customerId) as { count: number }
  ).count;

  const abandonedCarts = (
    db
      .prepare(`SELECT COUNT(*) AS count FROM cart_abandonment_events WHERE customer_id = ? AND status != 'paid'`)
      .get(customerId) as { count: number }
  ).count;

  const score =
    100 -
    disputeCount * HEALTH_WEIGHTS.disputePenalty -
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
      `SELECT timestamp, agent, action, reasoning FROM audit_log
       WHERE customer_id = ? AND (mode = ? OR mode IS NULL) ORDER BY timestamp ASC`,
    )
    .all(customerId, mode) as AuditLogEntry[];
  return rows;
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
}

export function getMemoryProfile(
  db: Database.Database,
  customerId: string,
  options: GetMemoryProfileOptions,
): CustomerMemoryProfile {
  const { count: disputeCount, totalAmount: totalDisputedAmount } = readDisputeStats(db, customerId);

  const profile: CustomerMemoryProfile = {
    customer_id: customerId,
    dispute_count: disputeCount,
    total_disputed_amount: totalDisputedAmount,
    discount_usage_history: readDiscountUsageHistory(db, customerId, options.mode),
    recovery_frequency: readRecoveryFrequency(db, customerId),
    rolling_health_score: computeRollingHealthScore(db, customerId, disputeCount),
    audit_log: readAuditLog(db, customerId, options.mode),
  };

  appendAuditLog(db, {
    customer_id: customerId,
    agent: options.requestedBy,
    mode: options.mode,
    action: "read_memory_profile",
    reasoning: options.reason,
    metadata: {
      dispute_count: profile.dispute_count,
      rolling_health_score: profile.rolling_health_score,
    },
  });

  return profile;
}
