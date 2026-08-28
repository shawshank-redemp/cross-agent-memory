// Payment instrument, shared by the order read model (last_method) and the
// subscription charge read model (method). Matches Razorpay's `method` enum
// on the payments report, narrowed to the four instruments this batch uses.
export type PaymentMethod = "card" | "upi" | "netbanking" | "wallet";

// CartAbandonmentEvent mirrors a row of Razorpay's ORDERS report. There is
// exactly one identifier — order_id — because a real orders export has
// exactly one `id` per order; the previous separate `event_id` was a
// fabricated second key for the same row.
//
// status follows Razorpay's order status enum (created/attempted/paid) —
// 'paid' is included so a recovered abandonment can be represented, not just
// the abandoned states.
export type CartAbandonmentStatus = "created" | "attempted" | "paid";
export type CartAbandonmentChannel = "web" | "app" | "whatsapp";

// Razorpay `notes` is a free-form key/value bag merchants attach to an order.
// Storefront detail that no signal reads (item count, acquisition channel)
// lives here rather than as promoted columns, which is where a real
// integration would put it too.
export interface CartOrderNotes {
  items: number;
  channel: CartAbandonmentChannel;
}

export interface CartAbandonmentEvent {
  order_id: string; // order_... — the single identifier for this row
  customer_id: string;
  amount: number; // paise, full order value
  amount_paid: number; // paise; 0 for an abandoned cart
  amount_due: number; // paise; amount - amount_paid
  currency: string;
  status: CartAbandonmentStatus;
  // Payment attempts made against this order. 0 = never tried to pay (intent
  // drop-off); >= 1 = tried and the payment failed (friction drop-off). This
  // is the field that will carry failure-reason branching later.
  attempts: number;
  // Denormalised from the order's most recent payment attempt. Null when
  // attempts = 0. On a `paid` order the last attempt succeeded, so
  // last_method is set but the two last_error_* fields are null.
  last_method: PaymentMethod | null;
  last_error_code: string | null;
  last_error_description: string | null;
  notes: CartOrderNotes;
  created_at: string;
}

// SubscriptionFailureEvent models a failed subscription CHARGE, because that
// is what a subscription billing failure actually is: a failed payment. The
// primary key is therefore payment_id — subscription_id repeats across
// cycles and cannot identify a row.
export type SubscriptionFailureStatus =
  | "active"
  | "failed"
  | "halted"
  | "cancelled"
  | "completed";

// Razorpay plan billing frequency (`period` + `interval`): interval 1 with
// period monthly = charged every month.
export type PlanPeriod = "monthly" | "yearly";

export interface SubscriptionFailureEvent {
  payment_id: string; // pay_... — the charge attempt, unique per cycle
  subscription_id: string; // sub_... — repeats across cycles
  customer_id: string;
  plan_id: string;
  plan_amount: number; // paise
  plan_period: PlanPeriod;
  plan_interval: number;
  // Razorpay's own column name for the cycle index (previously cycle_number).
  // Strictly it counts successful charges; CLAUDE.md ratifies using it as the
  // cycle counter for this batch.
  paid_count: number;
  total_count: number;
  status: SubscriptionFailureStatus;
  method: PaymentMethod;
  // Razorpay payments-report failure fields, replacing the free-text
  // `failure_reason`. Null when the cycle did not fail.
  error_code: string | null;
  error_description: string | null;
  created_at: string;
}

// DisputeEvent models settlements-recon dispute fields. Disputes annotate a
// payment/order rather than standing alone — payment_id/order_id are the join
// keys back into the CartAbandonmentEvent stream for cross-domain signals.
export type DisputeStatus = "open" | "under_review" | "won" | "lost" | "closed";

export interface DisputeEvent {
  dispute_id: string; // dispute_... — the single identifier for this row
  customer_id: string;
  payment_id: string;
  order_id: string; // the cross-domain join back to cart_abandonment_events
  amount: number; // paise
  dispute_reason: string;
  dispute_created_at: string; // when the dispute was filed
  // When the dispute reached a terminal status. Null while open/under_review.
  // Not a literal Razorpay column (their API exposes status transitions via
  // webhooks); it exists because the outcome of a dispute has a "when did we
  // learn this" dimension and must be filtered asOf like everything else —
  // otherwise a future `won` leaks backwards into a past decision.
  resolved_at: string | null;
  status: DisputeStatus;
}

export type AgentType = "cart_abandonment" | "subscription_recovery" | "dispute_responder";
