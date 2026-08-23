// CartAbandonmentEvent models an Order + its Payment attempt(s).
// status follows Razorpay order status enum (created/attempted/paid) — 'paid' is
// included so a recovered abandonment can be represented, not just the abandoned states.
export type CartAbandonmentStatus = "created" | "attempted" | "paid";
export type CartAbandonmentChannel = "web" | "app" | "whatsapp";

export interface CartAbandonmentEvent {
  event_id: string; // order_...
  customer_id: string;
  order_id: string;
  amount: number; // paise
  currency: string;
  status: CartAbandonmentStatus;
  cart_value: number; // paise
  items: number;
  channel: CartAbandonmentChannel;
  timestamp: string;
}

// SubscriptionFailureEvent models a Subscription's billing-cycle outcome.
// cycle_number maps to Razorpay's paid_count out of total_count.
export type SubscriptionFailureStatus =
  | "active"
  | "failed"
  | "halted"
  | "cancelled"
  | "completed";

export interface SubscriptionFailureEvent {
  event_id: string; // sub_...
  customer_id: string;
  subscription_id: string;
  plan_id: string;
  plan_amount: number; // paise
  cycle_number: number; // paid_count
  total_count: number;
  failure_reason: string | null;
  status: SubscriptionFailureStatus;
  timestamp: string;
}

// DisputeEvent models settlements-recon dispute fields. Disputes annotate a
// payment/order rather than standing alone — payment_id/order_id are the join
// keys back into the CartAbandonmentEvent stream for cross-domain signals.
export type DisputeStatus = "open" | "under_review" | "won" | "lost" | "closed";

export interface DisputeEvent {
  event_id: string; // dispute_...
  customer_id: string;
  payment_id: string;
  order_id: string;
  amount: number; // paise
  dispute_reason: string;
  dispute_created_at: string;
  status: DisputeStatus;
}

export type AgentType = "cart_abandonment" | "subscription_recovery" | "dispute_responder";
