import type { AgentType } from "./events.js";

// 'memory_read' rows record what an agent read before deciding; 'decision'
// rows record what it then did. Kept as a column rather than inferred from
// `action`, which used to be a string comparison against
// "read_memory_profile".
export type AuditEntryType = "memory_read" | "decision";

export interface AuditLogEntry {
  timestamp: string;
  agent: AgentType | "system";
  entry_type: AuditEntryType;
  action: string;
  reasoning: string;
  // Margin this decision committed, lifted out of the metadata JSON blob.
  // Null on memory_read rows and on decisions that committed nothing.
  committed_spend_paise: number | null;
  // Which policy governed this decision. Null on memory_read rows.
  policy_version: string | null;
}

export interface DiscountUsageRecord {
  timestamp: string;
  agent: AgentType;
  amount: number; // paise
  // The triggering event, whatever domain it came from. order_id is empty for
  // subscription and dispute events, so event_id is the only universal trace
  // back to the cause.
  event_id: string;
  order_id: string;
}

// A single recovery-flow triggering event, as of a profile read. This is the
// raw-fact counterpart to RecoveryFrequencyRecord's aggregate: signals that
// need to ask "did this happen RECENTLY" cannot answer it from a window that
// spans the customer's whole history.
//
// POPULATION: recovery-flow triggers only, matching the filters
// recovery_frequency already uses — non-paid carts, failed/halted
// subscription cycles, all disputes. A paid cart and a healthy subscription
// cycle are not evidence of churn, and including them would make a customer
// who successfully paid look like a churn risk.
export interface RecentEventRecord {
  agent: AgentType;
  timestamp: string;
}

export interface RecoveryFrequencyRecord {
  agent: AgentType;
  count: number;
  window_start: string;
  window_end: string;
}

// Disputes split by what is actually KNOWN as of the read, not by their
// eventual stored status.
//
// RAZORPAY SEMANTICS, and they are the opposite of the intuitive reading:
// the dispute entity belongs to the MERCHANT, not the customer, so the
// status describes how it went for the merchant.
//
//   status 'won'  = the bank ACCEPTED the merchant's evidence. The merchant
//                   won the chargeback and the customer's complaint was
//                   rejected. This is the CUSTOMER-ADVERSE outcome.
//   status 'lost' = the bank REJECTED the merchant's evidence and refunded
//                   the customer. Also the status set when a merchant simply
//                   ACCEPTS a dispute instead of contesting it. This is
//                   evidence about the MERCHANT's delivery, not the customer.
//
// The field names below deliberately do NOT reuse Razorpay's won/lost words,
// because reading `breakdown.won` as "the customer won" is exactly the
// inversion this code shipped with once already.
//
// - unresolved: filed, but no resolution visible yet. A dispute whose stored
//   status is terminal still counts here until its resolved_at is in the
//   past, because the outcome has not happened yet at this point in time.
// - merchant_conceded (Razorpay 'lost'): the merchant lost or accepted the
//   chargeback. Evidence about the merchant, so it drives no caution.
// - customer_adverse (Razorpay 'won'): the merchant successfully contested
//   it — the complaint did not hold up. This is the one that counts against
//   the customer.
// - closed_undetermined (Razorpay 'closed'): resolved with no ruling either
//   way — generally withdrawn or ended without a chargeback decision, so it
//   is neither exoneration nor fault and drives no caution.
//
// The four sum to dispute_count.
export interface DisputeBreakdown {
  unresolved: number;
  merchant_conceded: number;
  customer_adverse: number;
  closed_undetermined: number;
}

export interface CustomerMemoryProfile {
  customer_id: string;
  // All disputes FILED as of the read, any status — what the dashboard shows.
  dispute_count: number;
  total_disputed_amount: number; // paise
  dispute_breakdown: DisputeBreakdown;
  // paise; disputed amount from `customer_adverse` disputes only (Razorpay
  // status 'won') — the subset that is actually evidence about this customer.
  adverse_disputed_amount: number;
  // dispute_reason for each dispute counted as `unresolved` as of this read.
  // Exposed because at decision time most disputes ARE unresolved, so the
  // reason is the only evidence available about who is likely at fault. The
  // reason -> fault mapping itself lives in data/fixtures.ts and the rule that
  // uses it lives in the policy layer; this is the raw fact.
  unresolved_dispute_reasons: string[];
  discount_usage_history: DiscountUsageRecord[];
  recovery_frequency: RecoveryFrequencyRecord[];
  // Raw asOf-scoped event timestamps, ascending, bounded to the last
  // PROFILE_RECENT_EVENTS_LOOKBACK_DAYS. Facts only — the rule that reads them
  // (how recent counts as "recent") lives in policy.ts, not here.
  recent_events: RecentEventRecord[];
  // Successful transactions across ALL domains as of this read: paid orders
  // plus successful subscription cycles. Expressed in payment vocabulary
  // rather than cart/subscription vocabulary precisely so a fourth agent can
  // read it without translation.
  successful_payment_count: number;
  total_paid_amount: number; // paise
  rolling_health_score: number; // 0-100, higher is healthier
  audit_log: AuditLogEntry[];
}
