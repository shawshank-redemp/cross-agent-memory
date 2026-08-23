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

export const PLAN_DEFS: Record<PlanCode, { plan_amount: number; total_count: number }> = {
  basic: { plan_amount: 19900, total_count: 12 },
  standard: { plan_amount: 49900, total_count: 12 },
  premium: { plan_amount: 99900, total_count: 6 },
};

export const SUBSCRIPTION_FAILURE_REASONS = [
  "insufficient_funds",
  "card_expired",
  "bank_declined",
  "issuer_declined",
  "payment_method_removed",
];

export const DISPUTE_REASONS = [
  "goods_not_received",
  "duplicate_charge",
  "unrecognized_transaction",
  "service_not_as_described",
  "subscription_not_cancelled",
];

export const CART_CHANNELS = ["web", "app", "whatsapp"] as const;
