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

export interface RecoveryFrequencyRecord {
  agent: AgentType;
  count: number;
  window_start: string;
  window_end: string;
}

// Disputes split by what is actually KNOWN as of the read, not by their
// eventual stored status.
//
// - unresolved: filed, but no resolution visible yet. A dispute whose stored
//   status is terminal still counts here until its resolved_at is in the
//   past, because the outcome has not happened yet at this point in time.
// - won: resolved in the customer's favour. Evidence about the merchant, not
//   about the customer — it must not make the customer look riskier.
// - adverse: resolved against the customer (`lost`).
// - closed_undetermined: resolved with no ruling either way. `closed` in
//   Razorpay generally means withdrawn or ended without a chargeback
//   decision, so it is neither exoneration nor fault and drives no caution.
//
// The four sum to dispute_count.
export interface DisputeBreakdown {
  unresolved: number;
  won: number;
  adverse: number;
  closed_undetermined: number;
}

export interface CustomerMemoryProfile {
  customer_id: string;
  // All disputes FILED as of the read, any status — what the dashboard shows.
  dispute_count: number;
  total_disputed_amount: number; // paise
  dispute_breakdown: DisputeBreakdown;
  // paise; disputed amount from `adverse` disputes only — the subset that is
  // actually evidence about this customer.
  adverse_disputed_amount: number;
  discount_usage_history: DiscountUsageRecord[];
  recovery_frequency: RecoveryFrequencyRecord[];
  rolling_health_score: number; // 0-100, higher is healthier
  audit_log: AuditLogEntry[];
}
