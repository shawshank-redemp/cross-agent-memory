import type { Rng } from "../lib/rng.js";
import { createRng } from "../lib/rng.js";
import { makeId } from "../lib/ids.js";
import type {
  CartAbandonmentEvent,
  Customer,
  DisputeEvent,
  PlanTier,
  SubscriptionFailureEvent,
} from "../types/index.js";
import {
  CART_CHANNELS,
  DISPUTE_REASONS,
  EMAIL_DOMAINS,
  FIRST_NAMES,
  LAST_NAMES,
  PLAN_DEFS,
  SUBSCRIPTION_FAILURE_REASONS,
  type PlanCode,
} from "./fixtures.js";

// Fixed reference point so a given seed always reproduces the same batch —
// baseline-vs-memory comparison runs need to diff the same data.
const SIM_NOW = new Date("2026-08-23T00:00:00Z").getTime();
const DAY_MS = 24 * 60 * 60 * 1000;
const SIGNUP_LOOKBACK_DAYS = 730;
const EVENT_WINDOW_DAYS = 120;

export type Scenario =
  | "normal"
  | "repeat_offender_cart"
  | "repeat_offender_subscription"
  | "repeat_offender_dispute"
  | "cross_domain_risk"
  | "churn_signal"
  | "noise";

export interface ScenarioLabel {
  customer_id: string;
  scenario: Scenario;
  note: string;
}

export interface SyntheticBatch {
  customers: Customer[];
  cartAbandonmentEvents: CartAbandonmentEvent[];
  subscriptionFailureEvents: SubscriptionFailureEvent[];
  disputeEvents: DisputeEvent[];
  scenarioLabels: ScenarioLabel[];
}

export interface GenerateOptions {
  seed?: number;
  totalCustomers?: number;
}

function daysAgo(days: number): number {
  return SIM_NOW - days * DAY_MS;
}

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}

function makeCustomer(rng: Rng): Customer {
  const first = rng.pick(FIRST_NAMES);
  const last = rng.pick(LAST_NAMES);
  const planTier = rng.pick<PlanTier>(["basic", "standard", "premium"]);
  return {
    customer_id: makeId("cust", rng),
    name: `${first} ${last}`,
    email: `${first.toLowerCase()}.${last.toLowerCase()}${rng.int(1, 999)}@${rng.pick(EMAIL_DOMAINS)}`,
    contact: `+91${rng.int(6, 9)}${randomDigits(rng, 9)}`,
    signup_date: isoAt(daysAgo(rng.int(1, SIGNUP_LOOKBACK_DAYS))),
    plan_tier: planTier,
  };
}

function randomDigits(rng: Rng, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += rng.int(0, 9).toString();
  return out;
}

function randomTimestampWithinWindow(rng: Rng, windowDays = EVENT_WINDOW_DAYS): number {
  return daysAgo(rng.int(0, windowDays));
}

function makeCartAbandonmentEvent(
  rng: Rng,
  customer: Customer,
  timestampMs: number,
  status: CartAbandonmentEvent["status"],
): CartAbandonmentEvent {
  const cartValue = rng.int(5, 50) * 10_000; // paise: ₹500 - ₹5,000
  const orderId = makeId("order", rng);
  return {
    event_id: orderId,
    customer_id: customer.customer_id,
    order_id: orderId,
    amount: cartValue,
    currency: "INR",
    status,
    cart_value: cartValue,
    items: rng.int(1, 6),
    channel: rng.pick(CART_CHANNELS),
    timestamp: isoAt(timestampMs),
  };
}

function makeSubscriptionCycleEvent(
  rng: Rng,
  customer: Customer,
  subscriptionId: string,
  planId: string,
  planCode: PlanCode,
  cycleNumber: number,
  timestampMs: number,
  status: SubscriptionFailureEvent["status"],
): SubscriptionFailureEvent {
  const plan = PLAN_DEFS[planCode];
  return {
    event_id: makeId("sub", rng),
    customer_id: customer.customer_id,
    subscription_id: subscriptionId,
    plan_id: planId,
    plan_amount: plan.plan_amount,
    cycle_number: cycleNumber,
    total_count: plan.total_count,
    failure_reason: status === "failed" || status === "halted" ? rng.pick(SUBSCRIPTION_FAILURE_REASONS) : null,
    status,
    timestamp: isoAt(timestampMs),
  };
}

function makeDisputeEvent(
  rng: Rng,
  customer: Customer,
  timestampMs: number,
  status: DisputeEvent["status"],
  opts?: { orderId?: string },
): DisputeEvent {
  return {
    event_id: makeId("dispute", rng),
    customer_id: customer.customer_id,
    payment_id: makeId("pay", rng),
    order_id: opts?.orderId ?? makeId("order", rng),
    amount: rng.int(5, 80) * 10_000,
    dispute_reason: rng.pick(DISPUTE_REASONS),
    dispute_created_at: isoAt(timestampMs),
    status,
  };
}

function planCodeFor(customer: Customer): PlanCode {
  return customer.plan_tier;
}

// ~60%: one clean event, resolves fine — no cross-agent signal.
function generateNormal(rng: Rng, customer: Customer, batch: SyntheticBatch): void {
  const domain = rng.pick(["cart", "subscription", "dispute"] as const);
  const ts = randomTimestampWithinWindow(rng);

  if (domain === "cart") {
    batch.cartAbandonmentEvents.push(makeCartAbandonmentEvent(rng, customer, ts, "paid"));
  } else if (domain === "subscription") {
    const planCode = planCodeFor(customer);
    batch.subscriptionFailureEvents.push(
      makeSubscriptionCycleEvent(rng, customer, makeId("sub", rng), makeId("plan", rng), planCode, rng.int(1, 4), ts, "active"),
    );
  } else {
    batch.disputeEvents.push(makeDisputeEvent(rng, customer, ts, "won"));
  }
}

// ~5% (of 15% total): repeated abandoned carts — should trip gaming detection
// and a stopping rule on discount attempts.
function generateRepeatOffenderCart(rng: Rng, customer: Customer, batch: SyntheticBatch): void {
  const cycles = rng.int(4, 7);
  const timestamps = Array.from({ length: cycles }, () => randomTimestampWithinWindow(rng)).sort((a, b) => a - b);
  for (const ts of timestamps) {
    const status = rng.chance(0.15) ? "paid" : rng.pick(["created", "attempted"] as const);
    batch.cartAbandonmentEvents.push(makeCartAbandonmentEvent(rng, customer, ts, status));
  }
}

// ~5%: repeated subscription-cycle failures — recovery-frequency gaming +
// stopping rule material (use cycle_number to trace it).
function generateRepeatOffenderSubscription(rng: Rng, customer: Customer, batch: SyntheticBatch): void {
  const planCode = planCodeFor(customer);
  const subscriptionId = makeId("sub", rng);
  const planId = makeId("plan", rng);
  const failureCycles = rng.int(4, 6);
  const cycleGapDays = Math.floor((EVENT_WINDOW_DAYS - 5) / failureCycles);
  let ts = daysAgo(EVENT_WINDOW_DAYS);
  for (let cycle = 1; cycle <= failureCycles; cycle++) {
    ts = Math.min(ts + rng.int(cycleGapDays - 3, cycleGapDays + 3) * DAY_MS, SIM_NOW);
    const status = cycle === failureCycles && rng.chance(0.4) ? "halted" : "failed";
    batch.subscriptionFailureEvents.push(
      makeSubscriptionCycleEvent(rng, customer, subscriptionId, planId, planCode, cycle, ts, status),
    );
  }
}

// ~5%: repeat dispute filer across unrelated payments.
function generateRepeatOffenderDispute(rng: Rng, customer: Customer, batch: SyntheticBatch): void {
  const disputes = rng.int(3, 5);
  const timestamps = Array.from({ length: disputes }, () => randomTimestampWithinWindow(rng)).sort((a, b) => a - b);
  for (const ts of timestamps) {
    const status = rng.pick(["open", "under_review", "won", "lost"] as const);
    batch.disputeEvents.push(makeDisputeEvent(rng, customer, ts, status));
  }
}

// ~10%: a dispute on a completed order, followed later by a new abandoned
// cart from the same customer — shared order_id/payment_id history should
// suppress the cart-abandonment agent's discount spend on the new cart.
function generateCrossDomainRisk(rng: Rng, customer: Customer, batch: SyntheticBatch): void {
  const paidTs = daysAgo(EVENT_WINDOW_DAYS - rng.int(0, 20));
  const paidEvent = makeCartAbandonmentEvent(rng, customer, paidTs, "paid");
  batch.cartAbandonmentEvents.push(paidEvent);

  const disputeTs = paidTs + rng.int(2, 14) * DAY_MS;
  batch.disputeEvents.push(
    makeDisputeEvent(rng, customer, disputeTs, rng.pick(["under_review", "lost"] as const), {
      orderId: paidEvent.order_id,
    }),
  );

  const laterCartTs = disputeTs + rng.int(5, 30) * DAY_MS;
  batch.cartAbandonmentEvents.push(
    makeCartAbandonmentEvent(rng, customer, Math.min(laterCartTs, SIM_NOW), rng.pick(["created", "attempted"] as const)),
  );
}

// ~10%: 2+ domains firing within a tight window — composite churn signal
// that should trigger human escalation rather than more automated nudges.
function generateChurnSignal(rng: Rng, customer: Customer, batch: SyntheticBatch): void {
  const windowStart = daysAgo(rng.int(10, EVENT_WINDOW_DAYS - 14));
  const domains = rng.chance(0.3)
    ? (["cart", "subscription", "dispute"] as const)
    : rng.shuffle(["cart", "subscription", "dispute"] as const).slice(0, 2);

  for (const domain of domains) {
    const ts = windowStart + rng.int(0, 10) * DAY_MS;
    if (domain === "cart") {
      batch.cartAbandonmentEvents.push(
        makeCartAbandonmentEvent(rng, customer, ts, rng.pick(["created", "attempted"] as const)),
      );
    } else if (domain === "subscription") {
      const planCode = planCodeFor(customer);
      batch.subscriptionFailureEvents.push(
        makeSubscriptionCycleEvent(rng, customer, makeId("sub", rng), makeId("plan", rng), planCode, rng.int(1, 3), ts, "failed"),
      );
    } else {
      batch.disputeEvents.push(makeDisputeEvent(rng, customer, ts, rng.pick(["open", "under_review"] as const)));
    }
  }
}

// ~5%: pure noise / edge cases agents must handle without falling over.
function generateNoise(rng: Rng, customer: Customer, batch: SyntheticBatch): void {
  const variant = rng.int(0, 4);
  if (variant === 0) {
    // No events at all for this customer.
    return;
  }
  if (variant === 1) {
    // Zero-value abandoned cart.
    const ts = randomTimestampWithinWindow(rng);
    const event = makeCartAbandonmentEvent(rng, customer, ts, "attempted");
    batch.cartAbandonmentEvents.push({ ...event, amount: 0, cart_value: 0, items: 0 });
    return;
  }
  if (variant === 2) {
    // Contradictory subscription state: active status but a failure_reason set.
    const planCode = planCodeFor(customer);
    const ts = randomTimestampWithinWindow(rng);
    const event = makeSubscriptionCycleEvent(rng, customer, makeId("sub", rng), makeId("plan", rng), planCode, 1, ts, "active");
    batch.subscriptionFailureEvents.push({ ...event, failure_reason: rng.pick(SUBSCRIPTION_FAILURE_REASONS) });
    return;
  }
  if (variant === 3) {
    // Dispute closed the same instant it was created, unusually large amount.
    const ts = randomTimestampWithinWindow(rng);
    const event = makeDisputeEvent(rng, customer, ts, "closed");
    batch.disputeEvents.push({ ...event, amount: 500_000_00 });
    return;
  }
  // variant 4: two domains firing, but spread far apart — should NOT read as
  // a churn signal, exercising the "tight window" boundary.
  const cartTs = daysAgo(EVENT_WINDOW_DAYS);
  const subTs = daysAgo(5);
  batch.cartAbandonmentEvents.push(makeCartAbandonmentEvent(rng, customer, cartTs, "attempted"));
  const planCode = planCodeFor(customer);
  batch.subscriptionFailureEvents.push(
    makeSubscriptionCycleEvent(rng, customer, makeId("sub", rng), makeId("plan", rng), planCode, 1, subTs, "failed"),
  );
}

interface ScenarioBucket {
  scenario: Scenario;
  weight: number;
  note: string;
  generate: (rng: Rng, customer: Customer, batch: SyntheticBatch) => void;
}

const SCENARIO_BUCKETS: ScenarioBucket[] = [
  { scenario: "normal", weight: 0.6, note: "one clean, resolved event", generate: generateNormal },
  {
    scenario: "repeat_offender_cart",
    weight: 0.05,
    note: "repeated abandoned carts — gaming/stopping-rule target",
    generate: generateRepeatOffenderCart,
  },
  {
    scenario: "repeat_offender_subscription",
    weight: 0.05,
    note: "repeated billing-cycle failures — gaming/stopping-rule target",
    generate: generateRepeatOffenderSubscription,
  },
  {
    scenario: "repeat_offender_dispute",
    weight: 0.05,
    note: "repeat dispute filer",
    generate: generateRepeatOffenderDispute,
  },
  {
    scenario: "cross_domain_risk",
    weight: 0.1,
    note: "dispute history should suppress a later cart discount",
    generate: generateCrossDomainRisk,
  },
  {
    scenario: "churn_signal",
    weight: 0.1,
    note: "2+ domains in a tight window — should escalate to human",
    generate: generateChurnSignal,
  },
  { scenario: "noise", weight: 0.05, note: "edge case / malformed-ish data", generate: generateNoise },
];

function allocateCounts(total: number): Map<Scenario, number> {
  const counts = new Map<Scenario, number>();
  let allocated = 0;
  for (let i = 0; i < SCENARIO_BUCKETS.length - 1; i++) {
    const bucket = SCENARIO_BUCKETS[i]!;
    const count = Math.round(total * bucket.weight);
    counts.set(bucket.scenario, count);
    allocated += count;
  }
  const last = SCENARIO_BUCKETS[SCENARIO_BUCKETS.length - 1]!;
  counts.set(last.scenario, total - allocated);
  return counts;
}

export function generateSyntheticBatch(options: GenerateOptions = {}): SyntheticBatch {
  const { seed = 42, totalCustomers = 250 } = options;
  const rng = createRng(seed);

  const batch: SyntheticBatch = {
    customers: [],
    cartAbandonmentEvents: [],
    subscriptionFailureEvents: [],
    disputeEvents: [],
    scenarioLabels: [],
  };

  const counts = allocateCounts(totalCustomers);
  const scenarioAssignments: Scenario[] = [];
  for (const bucket of SCENARIO_BUCKETS) {
    const count = counts.get(bucket.scenario) ?? 0;
    for (let i = 0; i < count; i++) scenarioAssignments.push(bucket.scenario);
  }
  const shuffledAssignments = rng.shuffle(scenarioAssignments);

  const generatorByScenario = new Map(SCENARIO_BUCKETS.map((b) => [b.scenario, b] as const));
  const noteByScenario = new Map(SCENARIO_BUCKETS.map((b) => [b.scenario, b.note] as const));

  for (const scenario of shuffledAssignments) {
    const customer = makeCustomer(rng);
    batch.customers.push(customer);
    batch.scenarioLabels.push({
      customer_id: customer.customer_id,
      scenario,
      note: noteByScenario.get(scenario) ?? "",
    });
    generatorByScenario.get(scenario)!.generate(rng, customer, batch);
  }

  return batch;
}

export function summarizeBatch(batch: SyntheticBatch) {
  const scenarioCounts: Record<string, number> = {};
  for (const label of batch.scenarioLabels) {
    scenarioCounts[label.scenario] = (scenarioCounts[label.scenario] ?? 0) + 1;
  }
  return {
    customers: batch.customers.length,
    cartAbandonmentEvents: batch.cartAbandonmentEvents.length,
    subscriptionFailureEvents: batch.subscriptionFailureEvents.length,
    disputeEvents: batch.disputeEvents.length,
    scenarioCounts,
  };
}
