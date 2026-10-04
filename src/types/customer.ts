export type PlanTier = "basic" | "standard" | "premium";

export interface Customer {
  customer_id: string;
  name: string;
  email: string;
  contact: string;
  signup_date: string;
  plan_tier: PlanTier;
}
