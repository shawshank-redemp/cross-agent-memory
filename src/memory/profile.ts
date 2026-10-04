import type Database from "better-sqlite3";
import type {
  AgentType,
  AuditEntryType,
  AuditLogEntry,
  CustomerMemoryProfile,
  DiscountUsageRecord,
  DisputeBreakdown,
  InterventionOutcomeSummary,
  RecoveryActivity,
  RecoveryAgentActivity,
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
  // Which policy governed this decision (POLICY_FINGERPRINT). Null on
  // memory_read rows, which decide nothing.
  policyVersion?: string;
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
        escalate_to_human, policy_version, signals, policy_override, metadata)
     VALUES (@timestamp, @customer_id, @agent, @mode, @entry_type, @event_id, @action, @reasoning,
             @escalate_to_human, @policy_version, @signals, @policy_override, @metadata)
     ON CONFLICT(event_id, mode, entry_type) DO UPDATE SET
       timestamp = excluded.timestamp,
       customer_id = excluded.customer_id,
       agent = excluded.agent,
       action = excluded.action,
       reasoning = excluded.reasoning,
       escalate_to_human = excluded.escalate_to_human,
       policy_version = excluded.policy_version,
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
    policy_version: entry.policyVersion ?? null,
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

// How far back the "recent" half of recovery activity reaches. This is a
// STORAGE bound, not a policy threshold: it exists so the event list cannot
// grow without limit on a heavy customer, and it is deliberately much wider
// than any rule that reads it.
//
// INVARIANT: this must stay >= every policy lookback that reads recent_events.
// If a policy lookback ever exceeded it, that policy would silently see a
// truncated history and under-fire. thresholds.ts asserts this at module load.
export const PROFILE_RECENT_EVENTS_LOOKBACK_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

// The three recovery-flow populations, as SQL. ONE definition, used for both
// the counts and the raw list, which is the whole point of the merge: the two
// used to be written out separately and could drift.
//
// POPULATION: non-paid carts, failed/halted subscription cycles, all disputes.
// A paid cart and a healthy cycle are not recovery triggers, so neither belongs
// in a frequency count or a churn signal. NOTE this is deliberately NOT the
// same as db/eligibility.ts: that decides which events get a DECISION and
// excludes ruled disputes, because the responder has nothing left to file. A
// ruled dispute still happened and is still evidence, so it stays here. The two
// agree on carts and subscriptions and diverge on disputes by design.
const RECOVERY_SOURCES = [
  {
    agent: "cart_abandonment" as const,
    sql: `SELECT created_at AS ts FROM cart_abandonment_events
          WHERE customer_id = @customerId AND status != 'paid'`,
  },
  {
    agent: "subscription_recovery" as const,
    sql: `SELECT created_at AS ts FROM subscription_failure_events
          WHERE customer_id = @customerId AND status IN ('failed','halted')`,
  },
  {
    agent: "dispute_responder" as const,
    sql: `SELECT dispute_created_at AS ts FROM dispute_events
          WHERE customer_id = @customerId`,
  },
];

// Merged replacement for the old readRecoveryFrequency + readRecentEvents.
//
// Those two ran the SAME filters over the SAME tables and returned different
// answers, because one was all-time and the other 90-day bounded. On a real
// batch customer that meant recovery_frequency said 2 cart events while
// recent_events contained 1, in the same payload — and whichever a signal read
// decided whether it fired. Now both counts come off one pass, so they cannot
// disagree.
//
// `asOf`, when given, restricts every read to events at or before that
// timestamp. This is what makes the profile causal: without it a customer's
// first event would already see the count of all their eventual repeat events.
//
// When asOf is omitted (the dashboard's "final state" read) the recent window
// is anchored on the customer's most recent event instead, so the bound still
// holds rather than degenerating into "return everything".
function readRecoveryActivity(db: Database.Database, customerId: string, asOf?: string): RecoveryActivity {
  const rows: { agent: AgentType; timestamp: string }[] = [];
  for (const src of RECOVERY_SOURCES) {
    const clause = asOf ? " AND ts <= @asOf" : "";
    const found = db
      .prepare(`SELECT ts FROM (${src.sql}) ${clause ? `WHERE ts <= @asOf` : ""} ORDER BY ts ASC`)
      .all(asOf ? { customerId, asOf } : { customerId }) as { ts: string }[];
    for (const r of found) rows.push({ agent: src.agent, timestamp: r.ts });
  }
  rows.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));

  if (rows.length === 0) return { by_agent: [], recent_events: [] };

  const anchor = asOf ?? rows[rows.length - 1]!.timestamp;
  const floor = new Date(Date.parse(anchor) - PROFILE_RECENT_EVENTS_LOOKBACK_DAYS * DAY_MS).toISOString();

  const by_agent: RecoveryAgentActivity[] = [];
  for (const src of RECOVERY_SOURCES) {
    const mine = rows.filter((r) => r.agent === src.agent);
    // Only agents with at least one qualifying event appear: a window with zero
    // events has no meaningful start/end.
    if (mine.length === 0) continue;
    by_agent.push({
      agent: src.agent,
      count_all_time: mine.length,
      count_recent: mine.filter((r) => r.timestamp >= floor).length,
      window_start: mine[0]!.timestamp,
      window_end: mine[mine.length - 1]!.timestamp,
    });
  }

  return { by_agent, recent_events: rows.filter((r) => r.timestamp >= floor) };
}

// How long after acting we are allowed to know whether it worked.
//
// A customer does not pay the instant an offer is sent. If an outcome were
// written at decision time, the very next decision on that customer could read
// a result that had not happened yet — the same temporal leak already fixed
// twice in this file (dispute resolved_at, and the discount/audit asOf scoping).
// So an outcome row carries observed_at = decided_at + this, and the read below
// filters on observed_at, never decided_at.
export const INTERVENTION_OBSERVATION_LAG_DAYS = 3;

// The feedback loop. Rolled up per (agent, action) rather than returned raw:
// the decision needs a hit rate, not a transcript.
//
// asOf-scoped on observed_at for the reason above, and mode-scoped for the same
// reason discount_usage is — a memory-informed read must not see the baseline
// run's outcomes as if they were its own.
function readInterventionOutcomes(
  db: Database.Database,
  customerId: string,
  mode: "baseline" | "memory",
  asOf?: string,
): InterventionOutcomeSummary[] {
  const rows = db
    .prepare(
      `SELECT agent, action, converted, committed_spend_paise, amount_collected_paise
       FROM intervention_outcomes
       WHERE customer_id = @customerId AND mode = @mode
       ${asOf ? "AND observed_at <= @asOf" : ""}`,
    )
    .all(asOf ? { customerId, mode, asOf } : { customerId, mode }) as {
    agent: AgentType;
    action: string;
    converted: number;
    committed_spend_paise: number | null;
    amount_collected_paise: number;
  }[];

  const byKey = new Map<string, InterventionOutcomeSummary>();
  for (const r of rows) {
    const key = `${r.agent}|${r.action}`;
    const acc =
      byKey.get(key) ??
      { agent: r.agent, action: r.action, attempts: 0, conversions: 0, spend_paise: 0, collected_paise: 0 };
    acc.attempts += 1;
    acc.conversions += r.converted ? 1 : 0;
    acc.spend_paise += r.committed_spend_paise ?? 0;
    acc.collected_paise += r.amount_collected_paise;
    byKey.set(key, acc);
  }
  return [...byKey.values()].sort((a, b) => (a.agent + a.action < b.agent + b.action ? -1 : 1));
}

// Records one intervention and the result it eventually had. Written by the
// runner after enforcePolicy has settled the decision, so `action` and
// `committed_spend_paise` are the FINAL values, not what the model first asked
// for. Idempotent on (event_id, mode) like discount_usage, so --resume and
// re-decides replace rather than duplicate.
export interface RecordInterventionOutcomeInput {
  customerId: string;
  agent: AgentType;
  mode: "baseline" | "memory";
  eventId: string;
  action: string;
  committedSpendPaise: number | null;
  converted: boolean;
  amountCollectedPaise: number;
  decidedAt: string;
}

export function recordInterventionOutcome(
  db: Database.Database,
  input: RecordInterventionOutcomeInput,
): void {
  const observedAt = new Date(
    Date.parse(input.decidedAt) + INTERVENTION_OBSERVATION_LAG_DAYS * DAY_MS,
  ).toISOString();
  db.prepare(
    `INSERT INTO intervention_outcomes
       (customer_id, agent, mode, event_id, action, committed_spend_paise,
        converted, amount_collected_paise, decided_at, observed_at)
     VALUES (@customerId, @agent, @mode, @eventId, @action, @committedSpendPaise,
             @converted, @amountCollectedPaise, @decidedAt, @observedAt)
     ON CONFLICT(event_id, mode) DO UPDATE SET
       agent = excluded.agent,
       action = excluded.action,
       committed_spend_paise = excluded.committed_spend_paise,
       converted = excluded.converted,
       amount_collected_paise = excluded.amount_collected_paise,
       decided_at = excluded.decided_at,
       observed_at = excluded.observed_at`,
  ).run({
    customerId: input.customerId,
    agent: input.agent,
    mode: input.mode,
    eventId: input.eventId,
    action: input.action,
    committedSpendPaise: input.committedSpendPaise,
    converted: input.converted ? 1 : 0,
    amountCollectedPaise: input.amountCollectedPaise,
    decidedAt: input.decidedAt,
    observedAt: observedAt,
  });
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


// REMOVED: computeRollingHealthScore.
//
// It subtracted a fixed penalty per event and looked at neither recency nor
// density, so it measured event VOLUME rather than risk. Measured across all 700
// customers it scored the churn_signal cohort (median 91) as healthier than
// repeat_offender_cart (88) and cross_agent_gaming (76) — it ranked the
// highest-risk group best, under a label reading "higher is healthier".
//
// It was pulled from the model payload first, on the grounds that a summary
// which inverts the ranking is worse than no summary when the model already
// receives the counts it is built from. That argument does not stop at the
// model: a person reading a dashboard is no more immune to a number that says
// the opposite of the truth. Nothing read it — no signal, no policy — and it
// cost two of the nine SQL queries in every profile read.
//
// A version worth having would be a RATIO (failures over total activity) rather
// than a subtraction from 100, and would age out. That is a different field, and
// it should be built when something actually needs it.

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
      `SELECT timestamp, agent, entry_type, action, reasoning, policy_version, metadata FROM audit_log
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
    recovery_activity: readRecoveryActivity(db, customerId, asOf),
    intervention_outcomes: readInterventionOutcomes(db, customerId, mode, asOf),
    successful_payment_count: payments.successfulPaymentCount,
    total_paid_amount: payments.totalPaidAmount,
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
    },
  });

  return profile;
}
