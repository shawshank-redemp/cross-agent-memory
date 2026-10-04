import type { PlanPeriod } from "../types/events.js";

export const FIRST_NAMES = [
  "Aarav", "Vivaan", "Aditya", "Vihaan", "Arjun", "Sai", "Reyansh", "Krishna",
  "Ishaan", "Rohan", "Kabir", "Aryan", "Dhruv", "Karan", "Nikhil", "Rahul",
  "Ananya", "Diya", "Isha", "Kavya", "Meera", "Priya", "Riya", "Saanvi",
  "Tara", "Neha", "Pooja", "Shreya", "Anjali", "Divya", "Kiran", "Lakshmi",
];

export const LAST_NAMES = [
  "Sharma", "Verma", "Gupta", "Patel", "Reddy", "Iyer", "Nair", "Menon",
  "Rao", "Kumar", "Singh", "Mehta", "Joshi", "Kapoor", "Chopra", "Bhat",
  "Desai", "Pillai", "Agarwal", "Bose", "Chatterjee", "Das", "Pandey", "Trivedi",
];

export const EMAIL_DOMAINS = ["gmail.com", "yahoo.com", "outlook.com", "rediffmail.com"];

export type PlanCode = "basic" | "standard" | "premium";

// plan_period / plan_interval are real Razorpay plan columns (`period` and
// `interval`: interval 1 + period monthly = billed monthly). Every plan here
// is monthly/1 because the generator spaces subscription cycles ~20-30 days
// apart; a yearly plan would contradict its own event timestamps. Carried for
// report fidelity — no signal reads them today.
export const PLAN_DEFS: Record<
  PlanCode,
  { plan_amount: number; total_count: number; plan_period: PlanPeriod; plan_interval: number }
> = {
  basic: { plan_amount: 19900, total_count: 12, plan_period: "monthly", plan_interval: 1 },
  standard: { plan_amount: 49900, total_count: 12, plan_period: "monthly", plan_interval: 1 },
  premium: { plan_amount: 99900, total_count: 6, plan_period: "monthly", plan_interval: 1 },
};

// The existing failure vocabulary, kept as the generator's selection keys.
export const SUBSCRIPTION_FAILURE_REASONS = [
  "insufficient_funds",
  "card_expired",
  "bank_declined",
  "issuer_declined",
  "payment_method_removed",
] as const;

export type SubscriptionFailureReason = (typeof SUBSCRIPTION_FAILURE_REASONS)[number];

export interface PaymentError {
  error_code: string;
  error_description: string;
}

// Razorpay's payments report carries `error_code` from a small fixed set
// (BAD_REQUEST_ERROR / GATEWAY_ERROR / SERVER_ERROR) alongside a
// human-readable `error_description`. The reasons above map onto that shape
// rather than becoming a new invented enum of their own.
export const SUBSCRIPTION_ERROR_BY_REASON: Record<SubscriptionFailureReason, PaymentError> = {
  insufficient_funds: {
    error_code: "BAD_REQUEST_ERROR",
    error_description: "Your payment did not go through as your account does not have sufficient balance.",
  },
  card_expired: {
    error_code: "BAD_REQUEST_ERROR",
    error_description: "Your payment failed because the card used has expired.",
  },
  bank_declined: {
    error_code: "GATEWAY_ERROR",
    error_description: "Your payment was declined by the bank. Please try another payment method.",
  },
  issuer_declined: {
    error_code: "BAD_REQUEST_ERROR",
    error_description: "Your payment was declined by the card issuer. Please contact your bank.",
  },
  payment_method_removed: {
    error_code: "BAD_REQUEST_ERROR",
    error_description: "The payment method saved on this subscription is no longer available.",
  },
};

export const PAYMENT_METHODS = ["card", "upi", "netbanking", "wallet"] as const;

// Checkout-side failures for an order whose payment was attempted and failed.
// Same Razorpay error_code/error_description shape as above.
export const CHECKOUT_ERRORS: PaymentError[] = [
  {
    error_code: "BAD_REQUEST_ERROR",
    error_description: "Your payment did not go through as your account does not have sufficient balance.",
  },
  {
    error_code: "BAD_REQUEST_ERROR",
    error_description: "Payment processing cancelled by user.",
  },
  {
    error_code: "GATEWAY_ERROR",
    error_description: "Your payment was declined by the bank. Please try another payment method.",
  },
  {
    error_code: "GATEWAY_ERROR",
    error_description: "Payment failed because the OTP was not entered in time.",
  },
  {
    error_code: "BAD_REQUEST_ERROR",
    error_description: "Your payment was declined by the card issuer. Please contact your bank.",
  },
];

// Who a dispute reason points at, before any ruling exists.
//
// In reality a dispute takes weeks to resolve, so at decision time MOST
// disputes are unresolved and the reason is the only evidence available. A
// customer claiming goods never arrived is making a claim about the merchant;
// a customer claiming they do not recognise their own transaction is making a
// claim that, if wrong, points at them.
//
// "neutral" is the default for anything not listed, and unknown reasons must
// resolve to "neutral" rather than "customer" — an unrecognised reason string
// must never manufacture suspicion about a customer.
export type DisputeFault = "merchant" | "customer" | "neutral";

export const DISPUTE_FAULT_BY_REASON: Record<string, DisputeFault> = {
  goods_not_received: "merchant",
  service_not_as_described: "merchant",
  unrecognized_transaction: "customer",
  duplicate_charge: "neutral",
  subscription_not_cancelled: "neutral",
};

export function disputeFaultForReason(reason: string): DisputeFault {
  return DISPUTE_FAULT_BY_REASON[reason] ?? "neutral";
}

export const DISPUTE_REASONS = [
  "goods_not_received",
  "duplicate_charge",
  "unrecognized_transaction",
  "service_not_as_described",
  "subscription_not_cancelled",
];

export const CART_CHANNELS = ["web", "app", "whatsapp"] as const;
