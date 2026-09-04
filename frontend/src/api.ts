// Mirrors the Scenario union in src/data/generator.ts. It had fallen three
// scenarios behind the generator (loyal_payer, conflicted_customer,
// cross_agent_gaming), which SCENARIO_LABELS below already listed — so the two
// disagreed and `npm run build` in this directory did not compile. The root
// `npm run typecheck` does not cover the frontend, which is why it went
// unnoticed.
export type Scenario =
  | "normal"
  | "repeat_offender_cart"
  | "repeat_offender_subscription"
  | "repeat_offender_dispute"
  | "cross_domain_risk"
  | "churn_signal"
  | "loyal_payer"
  | "conflicted_customer"
  | "cross_agent_gaming"
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

export interface RecoveryAgentActivity {
  agent: string;
  // Two counts because the backend now holds both: all-time and the
  // last-90-days subset. They used to be two separate profile fields computed
  // from the same events, and they disagreed.
  count_all_time: number;
  count_recent: number;
  window_start: string;
  window_end: string;
}

export interface RecoveryActivity {
  by_agent: RecoveryAgentActivity[];
  recent_events: { agent: string; timestamp: string }[];
}

// What we did to this customer before, and whether it worked.
export interface InterventionOutcomeSummary {
  agent: string;
  action: string;
  attempts: number;
  conversions: number;
  spend_paise: number;
  collected_paise: number;
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
    recovery_activity: RecoveryActivity;
    intervention_outcomes: InterventionOutcomeSummary[];
    rolling_health_score: number;
  };
  discountHistory: { baseline: unknown[]; memory: unknown[] };
  auditLog: { baseline: AuditLogEntry[]; memory: AuditLogEntry[] };
}


// ---------------------------------------------------------------- replay trace

// One step of a decision, as captured in agent_trace_events. `detail` is the
// structured payload the agent wrote; its shape varies by step_name, so it is
// typed as unknown here and narrowed at each use site rather than pretended to
// be uniform.
//
// Rows written before the trace carried structured payloads hold only
// { summary }. The replay page must render that as a gap rather than filling it
// in — see the no-substitution rule on the endpoint.
export interface TraceStep {
  step_order: number;
  step_name: string;
  duration_ms: number;
  started_at: string;
  detail: { summary: string } & Record<string, unknown>;
}

export interface TracedDecisionShape {
  reasoning: string;
  memory_factors_used: string[];
  action: string;
  committed_spend_paise: number | null;
  escalate_to_human: boolean;
  escalation_reason: string | null;
}

export interface GuardrailDetail {
  summary: string;
  applied: boolean;
  proposed: TracedDecisionShape;
  final: TracedDecisionShape;
  cap_percent: number;
  cap_paise: number;
  event_amount_paise: number;
  capping_signal: string | null;
  blocking_signals: string[];
  escalating_signals: string[];
  notes: string[];
  triggered_by: string[];
}

export interface EvaluatedSignal {
  id: string;
  kind: "brake" | "accelerator" | "router";
  scope: "customer" | "agent";
  value: unknown;
  active: boolean;
  describe: string | null;
  effects: { blocksDiscount?: boolean; forcesEscalation?: boolean; discountCapPercent?: number };
}

export interface TraceArm {
  mode: "baseline" | "memory";
  steps: TraceStep[];
  decision: {
    action: string;
    reasoning: string;
    escalate_to_human: boolean;
    committed_spend_paise: number | null;
    escalation_reason: string | null;
    memory_factors_used: string[];
    unsupported_factor_citations: string[];
    policy_version: string | null;
    signals: Record<string, unknown> | null;
    policy_override: Record<string, unknown> | null;
    timestamp: string;
  } | null;
  // Expected steps with no captured row. Rendered as an explicit gap; never
  // silently filled.
  missing: string[];
}

export interface ReplayTrace {
  customer: CustomerDetail["customer"];
  scenario: Scenario | null;
  note: string;
  timeline: TimelineEvent[];
  replayableEventIds: string[];
  event: TimelineEvent | null;
  arms: { baseline: TraceArm; memory: TraceArm } | null;
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
  // True when this link already existed for the event and was fetched rather
  // than created. Surfaced so a reused link is never presented as a fresh one.
  reused?: boolean;
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
  trace: (id: string, eventId?: string) =>
    getJson<ReplayTrace>(
      `/api/customers/${id}/trace${eventId ? `?eventId=${encodeURIComponent(eventId)}` : ""}`,
    ),
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
