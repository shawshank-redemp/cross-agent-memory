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
  crossDomainSuppression: {
    customersChecked: number;
    suppressed: number;
    unchanged: number;
    details: { customer_id: string; event_id: string; baselineDiscount: number | null; memoryDiscount: number | null }[];
  };
}

export interface DecisionRecord {
  agent: string;
  customer_id: string;
  event_id: string;
  action: string;
  discount_amount: number | null;
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

export const api = {
  customers: () => getJson<CustomerSummary[]>("/api/customers"),
  customerDetail: (id: string) => getJson<CustomerDetail>(`/api/customers/${id}`),
  comparison: () => getJson<ComparisonReport>("/api/comparison"),
};

export const SCENARIO_LABELS: Record<Scenario, string> = {
  normal: "Normal",
  repeat_offender_cart: "Repeat Offender (Cart)",
  repeat_offender_subscription: "Repeat Offender (Subscription)",
  repeat_offender_dispute: "Repeat Offender (Dispute)",
  cross_domain_risk: "Cross-Domain Risk",
  churn_signal: "Churn Signal",
  noise: "Noise / Edge Case",
};

export function formatPaise(paise: number): string {
  return `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}
