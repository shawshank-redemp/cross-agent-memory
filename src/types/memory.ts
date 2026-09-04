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

// One agent's recovery-flow activity for this customer, as of the read.
//
// TWO COUNTS, DELIBERATELY. `count_all_time` and `count_recent` used to live in
// two separate profile fields (recovery_frequency, all-time; recent_events,
// 90-day) computed from the SAME population with the SAME filters. They
// routinely disagreed — one real customer showed 2 cart events all-time and 1
// in recent_events, because the older cart fell outside the 90-day bound — and
// whichever field a signal happened to read decided whether it fired. Holding
// both on one record removes the contradiction without forcing a single window
// on every signal: a stopping rule legitimately wants "ever", a churn rule
// legitimately wants "lately".
export interface RecoveryAgentActivity {
  agent: AgentType;
  // Every qualifying event for this agent, no time bound.
  count_all_time: number;
  // The subset within PROFILE_RECENT_EVENTS_LOOKBACK_DAYS of the read.
  count_recent: number;
  // First and last qualifying event, all-time. Kept for the dashboard; no
  // signal reads them.
  window_start: string;
  window_end: string;
}

// The merged replacement for recovery_frequency + recent_events. Counts and
// the raw event list are the same facts at two levels of detail, so they now
// travel together and cannot drift apart.
export interface RecoveryActivity {
  by_agent: RecoveryAgentActivity[];
  // Raw asOf-scoped events, ascending, bounded to
  // PROFILE_RECENT_EVENTS_LOOKBACK_DAYS. Facts only — the rule that reads them
  // (how recent counts as "recent") lives in the signal registry, not here.
  recent_events: RecentEventRecord[];
}

// WHAT WE DID, AND WHETHER IT WORKED.
//
// Every other field in this profile records what the CUSTOMER did. This one
// records what WE did and how it turned out, which is the only way an agent
// facing its fourth decision on a customer can learn "discounts do not work on
// this person". Without it the memory layer has no feedback loop at all: it
// knows a discount was granted and never whether it was redeemed.
//
// DELIBERATELY NOT DISCOUNT-SPECIFIC. `action` is the agent's own action
// string, so a reminder, a retry, an escalation and a discount are all recorded
// the same way, and an agent added later records its own actions with no schema
// change. Scoping this to discounts would have made it useless to any agent
// whose main lever is not a discount.
export interface InterventionOutcomeRecord {
  agent: AgentType;
  action: string;
  committed_spend_paise: number | null;
  converted: boolean;
  amount_collected_paise: number;
  event_id: string;
  // When we acted, and when the result became knowable. observed_at is
  // decided_at + INTERVENTION_OBSERVATION_LAG_DAYS: a customer does not pay the
  // instant an offer is sent, and writing the result at decision time would let
  // the next decision read an outcome that had not happened yet. Same bug class
  // as reading a dispute's `status` before its `resolved_at`.
  decided_at: string;
  observed_at: string;
}

// Rolled up per (agent, action) so the payload carries a hit rate rather than a
// transcript. The raw records stay in the table for audit.
export interface InterventionOutcomeSummary {
  agent: AgentType;
  action: string;
  attempts: number;
  conversions: number;
  spend_paise: number;
  collected_paise: number;
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
  // Replaces the old recovery_frequency + recent_events pair, which computed
  // the same population twice and disagreed. See RecoveryActivity.
  recovery_activity: RecoveryActivity;
  // What we did to this customer before, and whether it worked. The feedback
  // loop: every other field says what the customer did.
  intervention_outcomes: InterventionOutcomeSummary[];
  // Successful transactions across ALL domains as of this read: paid orders
  // plus successful subscription cycles. Expressed in payment vocabulary
  // rather than cart/subscription vocabulary precisely so a fourth agent can
  // read it without translation.
  successful_payment_count: number;
  total_paid_amount: number; // paise
  // 0-100, higher is healthier. DASHBOARD ONLY — deliberately not sent to the
  // model any more. It subtracts a fixed penalty per event and looks at neither
  // recency nor density, so it measures event VOLUME rather than risk: measured
  // on the committed batch it scored the churn_signal cohort (median 91)
  // healthier than repeat_offender_cart (88) and cross_agent_gaming (76),
  // i.e. it argued the wrong way on the highest-risk group. A wrong summary is
  // worse than no summary when the model already receives the counts it is
  // built from. A version the model could trust would be a RATIO (failures over
  // total activity) rather than a subtraction from 100; that is separate work.
  rolling_health_score: number;
  audit_log: AuditLogEntry[];
}
