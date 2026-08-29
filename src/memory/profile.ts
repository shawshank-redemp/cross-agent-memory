import type Database from "better-sqlite3";
import type {
  AgentType,
  AuditEntryType,
  AuditLogEntry,
  CustomerMemoryProfile,
  DiscountUsageRecord,
  DisputeBreakdown,
  RecentEventRecord,
  RecoveryFrequencyRecord,
} from "../types/index.js";

// What the model originally asked for, and which signals overrode it.
// Recorded on the decision's audit row so "the LLM proposes, deterministic
// code disposes" is a query, not a claim.
export interface PolicyOverrideRecord {
  original_action: string;
  original_committed_spend_paise: number | null;
  original_escalate_to_human: boolean;
  triggered_by: string[];
  notes: string;
  // True when policy escalated a decision the model did not escalate, so
  // escalation_reason was set to "policy_constraint" rather than by the model.
  escalation_reason_forced?: boolean;
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
  // Idempotent on (event_id, mode, entry_type) — see schema.sql. Rows with a
  // NULL event_id are unaffected, since SQLite treats each NULL as distinct.
  db.prepare(
    `INSERT INTO audit_log
       (timestamp, customer_id, agent, mode, entry_type, event_id, action, reasoning,
        escalate_to_human, signals, policy_override, metadata)
     VALUES (@timestamp, @customer_id, @agent, @mode, @entry_type, @event_id, @action, @reasoning,
             @escalate_to_human, @signals, @policy_override, @metadata)
     ON CONFLICT(event_id, mode, entry_type) DO UPDATE SET
       timestamp = excluded.timestamp,
       customer_id = excluded.customer_id,
       agent = excluded.agent,
       action = excluded.action,
       reasoning = excluded.reasoning,
       escalate_to_human = excluded.escalate_to_human,
       signals = excluded.signals,
       policy_override = excluded.policy_override,
       metadata = excluded.metadata`,
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
  // ON CONFLICT DO UPDATE, not a bare insert: re-deciding an event (which
  // --resume makes routine) must REPLACE that event's discount row, never add a
  // second one and never crash the run. See the unique index in schema.sql.
  db.prepare(
    `INSERT INTO discount_usage (customer_id, agent, mode, amount, event_id, order_id, timestamp)
     VALUES (@customer_id, @agent, @mode, @amount, @event_id, @order_id, @timestamp)
     ON CONFLICT(event_id, mode) DO UPDATE SET
       customer_id = excluded.customer_id,
       agent = excluded.agent,
       amount = excluded.amount,
       order_id = excluded.order_id,
       timestamp = excluded.timestamp`,
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
//
// ALSO asOf-scoped. This query was correct without it, but only accidentally:
// the guarantee lived in runner.ts sorting tagged events by timestamp and
// running each customer's queue sequentially in one worker, NOT in the query.
// Remove that sort, parallelise at event granularity, or add any out-of-order
// write path and temporal leakage returns silently — the same bug class as
// commit c33eed8, in one of the two fields that escaped it. Correctness now
// lives in the query, where it can be audited.
function readDiscountUsageHistory(
  db: Database.Database,
  customerId: string,
  mode: "baseline" | "memory",
  asOf?: string,
): DiscountUsageRecord[] {
  const rows = db
    .prepare(
      `SELECT agent, amount, event_id, order_id, timestamp FROM discount_usage
       WHERE customer_id = @customerId AND mode = @mode
       ${asOf ? "AND timestamp <= @asOf" : ""}
       ORDER BY timestamp ASC`,
    )
    .all(asOf ? { customerId, mode, asOf } : { customerId, mode }) as {
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

// How far back recent_events reaches. This is a STORAGE bound, not a policy
// threshold: it exists so the list cannot grow without limit on a heavy
// customer, and it is deliberately much wider than any rule that reads it.
//
// INVARIANT: this must stay >= every policy lookback in policy.ts that reads
// recent_events. If a policy lookback ever exceeds it, that policy would
// silently see a truncated history and under-fire. policy.ts asserts this at
// module load.
export const PROFILE_RECENT_EVENTS_LOOKBACK_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

// Raw recovery-flow triggering events, ascending, asOf-scoped and bounded to
// the lookback window above.
//
// Same population filters as readRecoveryFrequency (non-paid carts,
// failed/halted subscription cycles, all disputes): a paid cart or a healthy
// cycle is not a recovery trigger, so neither belongs in a churn or recency
// signal. See RecentEventRecord in types/memory.ts.
//
// When asOf is omitted (the dashboard's "final state" read) the window is
// anchored on the customer's most recent event instead, so the bound still
// holds rather than degenerating into "return everything".
function readRecentEvents(db: Database.Database, customerId: string, asOf?: string): RecentEventRecord[] {
  const anchor =
    asOf ??
    (
      db
        .prepare(
          `SELECT MAX(at) AS at FROM (
             SELECT MAX(created_at) AS at FROM cart_abandonment_events WHERE customer_id = @customerId AND status != 'paid'
             UNION ALL
             SELECT MAX(created_at) FROM subscription_failure_events WHERE customer_id = @customerId AND status IN ('failed','halted')
             UNION ALL
             SELECT MAX(dispute_created_at) FROM dispute_events WHERE customer_id = @customerId
           )`,
        )
        .get({ customerId }) as { at: string | null }
    ).at ??
    "";
  if (!anchor) return [];

  const floor = new Date(Date.parse(anchor) - PROFILE_RECENT_EVENTS_LOOKBACK_DAYS * DAY_MS).toISOString();

  return db
    .prepare(
      `SELECT 'cart_abandonment' AS agent, created_at AS timestamp FROM cart_abandonment_events
         WHERE customer_id = @customerId AND status != 'paid'
           AND created_at <= @anchor AND created_at >= @floor
       UNION ALL
       SELECT 'subscription_recovery' AS agent, created_at AS timestamp FROM subscription_failure_events
         WHERE customer_id = @customerId AND status IN ('failed','halted')
           AND created_at <= @anchor AND created_at >= @floor
       UNION ALL
       SELECT 'dispute_responder' AS agent, dispute_created_at AS timestamp FROM dispute_events
         WHERE customer_id = @customerId
           AND dispute_created_at <= @anchor AND dispute_created_at >= @floor
       ORDER BY timestamp ASC`,
    )
    .all({ customerId, anchor, floor }) as RecentEventRecord[];
}

interface PaymentHistory {
  successfulPaymentCount: number;
  totalPaidAmount: number; // paise
}

// "How much has this customer successfully transacted with us, across every
// domain" — the accelerator counterpart to the risk facts above, and a
// question no single agent can answer alone.
//
// Two sources, unioned:
//
//   Carts: every order that reached status 'paid' as of the cutoff counts as
//   one successful payment worth its amount_paid.
//
//   Subscriptions: the latest row per subscription_id as of the cutoff
//   carries that subscription's paid_count, which is Razorpay's count of
//   successful charges so far.
//
// APPROXIMATION, deliberate and worth knowing about: subscription value is
// computed as paid_count * plan_amount, which assumes the plan amount was
// stable across every one of those cycles. A real integration would sum the
// actual captured payments from the payments report rather than multiplying,
// and would not need the assumption at all. It is accurate here because the
// generator never changes a plan mid-subscription.
function readPaymentHistory(db: Database.Database, customerId: string, asOf?: string): PaymentHistory {
  const cartClause = asOf ? "AND created_at <= @asOf" : "";
  const cart = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount_paid), 0) AS total
       FROM cart_abandonment_events
       WHERE customer_id = @customerId AND status = 'paid' ${cartClause}`,
    )
    .get(asOf ? { customerId, asOf } : { customerId }) as { n: number; total: number };

  // Latest row per subscription as of the cutoff: paid_count on any earlier
  // row is a stale, lower count for the same subscription, so summing every
  // row would multiply-count the same successful cycles.
  const subClause = asOf ? "AND created_at <= @asOf" : "";
  const sub = db
    .prepare(
      `SELECT COALESCE(SUM(s.paid_count), 0) AS n,
              COALESCE(SUM(s.paid_count * s.plan_amount), 0) AS total
       FROM subscription_failure_events s
       JOIN (
         SELECT subscription_id, MAX(created_at) AS latest
         FROM subscription_failure_events
         WHERE customer_id = @customerId ${subClause}
         GROUP BY subscription_id
       ) m ON m.subscription_id = s.subscription_id AND m.latest = s.created_at
       WHERE s.customer_id = @customerId`,
    )
    .get(asOf ? { customerId, asOf } : { customerId }) as { n: number; total: number };

  return {
    successfulPaymentCount: cart.n + sub.n,
    totalPaidAmount: cart.total + sub.total,
  };
}

interface DisputeStats {
  count: number;
  totalAmount: number;
  breakdown: DisputeBreakdown;
  adverseAmount: number;
  // Reasons of the disputes counted as `unresolved` above, same asOf and same
  // resolved predicate. Facts only: the mapping from reason to who is at
  // fault, and what that should do to a discount, lives in the policy layer.
  unresolvedReasons: string[];
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
// Outcome mapping once resolved, and note it is the OPPOSITE of the intuitive
// reading — a Razorpay dispute belongs to the MERCHANT, so its status says how
// it went for the merchant, not for the customer:
//
//   'won'  -> customer_adverse: the merchant's evidence was accepted and the
//             complaint was rejected. This is what counts against a customer.
//   'lost' -> merchant_conceded: the merchant lost or accepted the chargeback
//             and the customer was refunded. Evidence about the merchant's
//             delivery, never about the customer, so it drives no caution.
//   'closed' -> neither: withdrawn or ended without a ruling, so penalising it
//             would charge the customer for a decision nobody made.
//
// See the DisputeBreakdown doc comment in types/memory.ts. This mapping is
// pinned by a fixture assertion in scripts/verifySchema.ts — if you flip it,
// that fails loudly rather than silently mispenalising every customer.
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
         SUM(CASE WHEN ${resolved} AND status = 'lost' THEN 1 ELSE 0 END) AS merchant_conceded,
         SUM(CASE WHEN ${resolved} AND status = 'won' THEN 1 ELSE 0 END) AS customer_adverse,
         SUM(CASE WHEN ${resolved} AND status = 'closed' THEN 1 ELSE 0 END) AS closed_undetermined,
         COALESCE(SUM(CASE WHEN ${resolved} AND status = 'won' THEN amount ELSE 0 END), 0) AS adverse_amount
       FROM dispute_events
       WHERE customer_id = @customerId ${visibleClause}`,
    )
    .get(asOf ? { customerId, asOf } : { customerId }) as {
    count: number;
    total: number;
    // SUM() over zero rows is NULL in SQLite, so these are nullable even
    // though every non-empty result is an integer.
    unresolved: number | null;
    merchant_conceded: number | null;
    customer_adverse: number | null;
    closed_undetermined: number | null;
    adverse_amount: number;
  };

  // Same visibility + resolved predicate as the aggregate above, so the
  // reasons returned are exactly the reasons of the `unresolved` bucket.
  const unresolvedReasons = (
    db
      .prepare(
        `SELECT dispute_reason FROM dispute_events
         WHERE customer_id = @customerId ${visibleClause} AND NOT ${resolved}
         ORDER BY dispute_created_at ASC`,
      )
      .all(asOf ? { customerId, asOf } : { customerId }) as { dispute_reason: string }[]
  ).map((r) => r.dispute_reason);

  return {
    count: row.count,
    totalAmount: row.total,
    unresolvedReasons,
    breakdown: {
      unresolved: row.unresolved ?? 0,
      merchant_conceded: row.merchant_conceded ?? 0,
      customer_adverse: row.customer_adverse ?? 0,
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
// dispute equally. A dispute the MERCHANT conceded (Razorpay 'lost') says the
// merchant failed to deliver, so it carries no penalty at all. A
// customer-adverse dispute (Razorpay 'won' — the merchant contested it and the
// complaint did not hold up) carries the full weight; a dispute still
// unresolved as of this read carries half, reflecting genuine uncertainty
// rather than established fault. `closed` disputes ended with no ruling
// either way and carry nothing.
const HEALTH_WEIGHTS = {
  customerAdverseDisputePenalty: 12,
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
    breakdown.customer_adverse * HEALTH_WEIGHTS.customerAdverseDisputePenalty -
    breakdown.unresolved * HEALTH_WEIGHTS.unresolvedDisputePenalty -
    failedCycles * HEALTH_WEIGHTS.failedSubscriptionCyclePenalty -
    abandonedCarts * HEALTH_WEIGHTS.abandonedCartPenalty;

  return Math.max(0, Math.min(100, score));
}

// Scoped to (mode OR NULL) for the same reason as discount_usage — a
// memory-informed read must not see the baseline run's decisions as if they
// were its own history. NULL-mode rows (system-level, not agent decisions)
// are cross-cutting and always included.
//
// asOf-scoped for the same reason as readDiscountUsageHistory above: the
// ordering guarantee belonged to the runner, not to this query. This is the
// read that feeds recent_decisions, so without it a decision could be shown
// decisions that had not happened yet.
function readAuditLog(
  db: Database.Database,
  customerId: string,
  mode: "baseline" | "memory",
  asOf?: string,
): AuditLogEntry[] {
  const rows = db
    .prepare(
      `SELECT timestamp, agent, entry_type, action, reasoning, metadata FROM audit_log
       WHERE customer_id = @customerId AND (mode = @mode OR mode IS NULL)
       ${asOf ? "AND timestamp <= @asOf" : ""}
       ORDER BY timestamp ASC`,
    )
    .all(asOf ? { customerId, mode, asOf } : { customerId, mode }) as (Omit<
    AuditLogEntry,
    "committed_spend_paise"
  > & { metadata: string | null })[];

  // The DB column keeps its original name (discount_amount); the decision
  // schema's rename to committed_spend_paise is mapped here, at the boundary.
  return rows.map(({ metadata, ...row }) => {
    let committed: number | null = null;
    if (metadata) {
      try {
        const parsed = JSON.parse(metadata) as { discount_amount?: number | null };
        committed = parsed.discount_amount ?? null;
      } catch {
        committed = null;
      }
    }
    return { ...row, committed_spend_paise: committed };
  });
}

// Pure — no audit_log side effect. Use this for read-only inspection (the
// dashboard API, ad-hoc queries); use getMemoryProfile below when an agent
// is actually consulting memory as part of making a decision, since that
// read itself is graded audit-trail material.
//
// `asOf` (ISO timestamp), when given, restricts EVERY read below to events at
// or before that point — pass the triggering event's own timestamp so a
// decision only ever sees its own past, never events that haven't happened yet.
// Omitting it still returns everything, which is the "final state" read the
// dashboard's whole-batch overview relies on.
export function computeMemoryProfile(
  db: Database.Database,
  customerId: string,
  mode: "baseline" | "memory",
  asOf?: string,
): CustomerMemoryProfile {
  const disputes = readDisputeStats(db, customerId, asOf);
  const payments = readPaymentHistory(db, customerId, asOf);

  return {
    customer_id: customerId,
    dispute_count: disputes.count,
    total_disputed_amount: disputes.totalAmount,
    dispute_breakdown: disputes.breakdown,
    adverse_disputed_amount: disputes.adverseAmount,
    unresolved_dispute_reasons: disputes.unresolvedReasons,
    discount_usage_history: readDiscountUsageHistory(db, customerId, mode, asOf),
    recovery_frequency: readRecoveryFrequency(db, customerId, asOf),
    recent_events: readRecentEvents(db, customerId, asOf),
    successful_payment_count: payments.successfulPaymentCount,
    total_paid_amount: payments.totalPaidAmount,
    rolling_health_score: computeRollingHealthScore(db, customerId, disputes.breakdown, asOf),
    audit_log: readAuditLog(db, customerId, mode, asOf),
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

// ONE CLOCK for audit_log. memory_read rows used to fall through to
// appendAuditLog's wall-clock default while decision rows were written with the
// event's own timestamp, so a single column ordered by `timestamp` held both
// synthetic batch dates and real ones. That makes any timestamp-ordered read of
// the table incoherent — and asOf filtering on audit_log (below) would compare
// an event's synthetic date against a real one and match nothing.


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
    // The event's own time, not wall-clock — see the note above.
    timestamp: options.asOf,
    metadata: {
      dispute_count: profile.dispute_count,
      dispute_breakdown: profile.dispute_breakdown,
      rolling_health_score: profile.rolling_health_score,
    },
  });

  return profile;
}
