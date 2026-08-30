export type Scenario =
  | "normal"
  | "repeat_offender_cart"
  | "repeat_offender_subscription"
  | "repeat_offender_dispute"
  | "cross_domain_risk"
  | "churn_signal"
  | "noise";

export interface CustomerSummary {
  customer_id: string;
  name: string;
  plan_tier: string;
  scenario: Scenario;
  eventCount: number;
  hasDivergence: boolean;
}

export interface ScenarioRollup {
  scenario: Scenario;
  customers: number;
  events: number;
  baselineDiscountPaise: number;
  memoryDiscountPaise: number;
  discountReducedPaise: number;
  discountIncreasedPaise: number;
  netDiscountChangePaise: number;
  baselineEscalations: number;
  memoryEscalations: number;
}

export interface SuppressionDetail {
  customer_id: string;
  event_id: string;
  dispute_outcome: string | null;
  baselineDiscount: number | null;
  memoryDiscount: number | null;
  suppressed: boolean;
}

export interface SuppressionCohortResult {
  customersChecked: number;
  suppressed: number;
  unchanged: number;
  details: SuppressionDetail[];
}

// Two cohorts with OPPOSITE expectations, split on how the planted dispute
// resolved. Same event shape in both — paid order, dispute on it, later
// abandoned cart — so suppressing is correct in one and a false positive in
// the other. Razorpay's dispute status describes how it went for the
// MERCHANT: 'won' means the merchant contested successfully (customer-adverse)
// and 'lost' means the merchant conceded and the customer was refunded.
export interface CrossDomainSuppression {
  expectation: { adverse: string; merchant_conceded: string };
  adverse: SuppressionCohortResult;
  merchant_conceded: SuppressionCohortResult;
  summary: {
    correctSuppressions: number;
    falsePositiveSuppressions: number;
    totalSuppressions: number;
    correctSuppressionRatePct: number | null;
    adverseSuppressionRatePct: number | null;
    merchantConcededSuppressionRatePct: number | null;
  };
}

export interface ComparisonReport {
  overall: {
    matchedEvents: number;
    customers: number;
    baselineDiscountPaise: number;
    memoryDiscountPaise: number;
    baselineEscalations: number;
    memoryEscalations: number;
    discountReducedPaise: number;
    discountIncreasedPaise: number;
    netDiscountChangePaise: number;
  };
  byScenario: ScenarioRollup[];
  crossDomainSuppression: CrossDomainSuppression;
}

export interface DecisionRecord {
  agent: string;
  customer_id: string;
  event_id: string;
  action: string;
  committed_spend_paise: number | null;
  escalation_reason: string | null;
  memory_factors_used: string[];
  policy_version?: string;
  escalate_to_human: boolean;
  reasoning: string;
}

export interface TimelineEvent {
  domain: string;
  event_id: string;
  timestamp: string;
  detail: Record<string, unknown>;
}

export interface RecoveryFrequencyRecord {
  agent: string;
  count: number;
  window_start: string;
  window_end: string;
}

export interface AuditLogEntry {
  timestamp: string;
  agent: string;
  action: string;
  reasoning: string;
}

export interface CustomerDetail {
  customer: {
    customer_id: string;
    name: string;
    email: string;
    contact: string;
    signup_date: string;
    plan_tier: string;
  };
  scenario: Scenario;
  note: string;
  events: TimelineEvent[];
  decisions: { baseline: DecisionRecord[]; memory: DecisionRecord[] };
  profileTimeline: {
    event_id: string;
    timestamp: string;
    rolling_health_score: number;
    dispute_count: number;
    cart_abandonment_count: number;
    subscription_recovery_count: number;
    dispute_responder_count: number;
  }[];
  profileCore: {
    dispute_count: number;
    total_disputed_amount: number;
    recovery_frequency: RecoveryFrequencyRecord[];
    rolling_health_score: number;
  };
  discountHistory: { baseline: unknown[]; memory: unknown[] };
  auditLog: { baseline: AuditLogEntry[]; memory: AuditLogEntry[] };
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export interface PaymentLinkRequest {
  customerId: string;
  eventId: string;
  amountPaise: number;
  description?: string;
}

export interface PaymentLinkResult {
  short_url: string;
  id: string;
  status: string;
}

// Unlike getJson, this surfaces the server's own error message rather than a
// bare status code: the point of the demo button is to show a REAL Razorpay
// response, and "422" alone would hide whether the key was wrong, the amount
// was rejected, or the network failed.
async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (parsed as { error?: string } | null)?.error;
    throw new Error(message ?? `${path} -> ${res.status}`);
  }
  return parsed as T;
}

export const api = {
  customers: () => getJson<CustomerSummary[]>("/api/customers"),
  customerDetail: (id: string) => getJson<CustomerDetail>(`/api/customers/${id}`),
  comparison: () => getJson<ComparisonReport>("/api/comparison"),
  createPaymentLink: (body: PaymentLinkRequest) => postJson<PaymentLinkResult>("/api/payment-links", body),
};

export const SCENARIO_LABELS: Record<Scenario, string> = {
  normal: "Normal",
  repeat_offender_cart: "Repeat Offender (Cart)",
  repeat_offender_subscription: "Repeat Offender (Subscription)",
  repeat_offender_dispute: "Repeat Offender (Dispute)",
  cross_domain_risk: "Cross-Domain Risk",
  churn_signal: "Churn Signal",
  loyal_payer: "Loyal Payer",
  conflicted_customer: "Conflicted (Gaming + Paying)",
  cross_agent_gaming: "Cross-Agent Gaming",
  noise: "Noise / Edge Case",
};

export function formatPaise(paise: number): string {
  return `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}
