import type { Rng } from "../lib/rng.js";
import { createRng } from "../lib/rng.js";
import { makeId } from "../lib/ids.js";
import type {
  CartAbandonmentEvent,
  Customer,
  DisputeEvent,
  DisputeStatus,
  PaymentMethod,
  PlanTier,
  SubscriptionFailureEvent,
} from "../types/index.js";
import {
  CART_CHANNELS,
  CHECKOUT_ERRORS,
  DISPUTE_REASONS,
  EMAIL_DOMAINS,
  FIRST_NAMES,
  LAST_NAMES,
  PAYMENT_METHODS,
  PLAN_DEFS,
  SUBSCRIPTION_ERROR_BY_REASON,
  SUBSCRIPTION_FAILURE_REASONS,
  type PlanCode,
  type SubscriptionFailureReason,
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
  // cross_domain_risk only: which outcome the planted dispute took. Recorded
  // here so downstream analysis can split the cohort by outcome without
  // re-deriving it from dispute_events — and, more to the point, without
  // having to guess which of a customer's disputes was the planted one.
  dispute_outcome?: DisputeStatus;
}

// What a scenario generator can tell the caller about the customer it just
// planted, merged onto that customer's ScenarioLabel. Ground truth about how
// the data was constructed, never something an agent is allowed to read.
export type ScenarioAnnotation = Pick<ScenarioLabel, "dispute_outcome">;

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

// Attempt state is generated coherently with `status`, because the two are
// the same fact seen from two angles in a real orders report:
//   created   -> never reached payment: attempts 0, every last_* field null
//   attempted -> tried and failed: attempts >= 1, method + error populated
//   paid      -> the final attempt succeeded: method set, errors null
// That last case is a refinement of "attempts >= 1 means last_* populated":
// a successful attempt has a method but no error to report.
function makeCartAbandonmentEvent(
  rng: Rng,
  customer: Customer,
  timestampMs: number,
  status: CartAbandonmentEvent["status"],
): CartAbandonmentEvent {
  const amount = rng.int(5, 50) * 10_000; // paise: ₹500 - ₹5,000
  const amountPaid = status === "paid" ? amount : 0;

  let attempts = 0;
  let lastMethod: PaymentMethod | null = null;
  let lastError: { error_code: string; error_description: string } | null = null;
  if (status === "attempted") {
    attempts = rng.int(1, 3);
    lastMethod = rng.pick(PAYMENT_METHODS);
    lastError = rng.pick(CHECKOUT_ERRORS);
  } else if (status === "paid") {
    attempts = rng.int(1, 2);
    lastMethod = rng.pick(PAYMENT_METHODS);
  }

  return {
    order_id: makeId("order", rng),
    customer_id: customer.customer_id,
    amount,
    amount_paid: amountPaid,
    amount_due: amount - amountPaid,
    currency: "INR",
    status,
    attempts,
    last_method: lastMethod,
    last_error_code: lastError?.error_code ?? null,
    last_error_description: lastError?.error_description ?? null,
    notes: { items: rng.int(1, 6), channel: rng.pick(CART_CHANNELS) },
    created_at: isoAt(timestampMs),
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
  const failed = status === "failed" || status === "halted";
  const error = failed ? SUBSCRIPTION_ERROR_BY_REASON[rng.pick(SUBSCRIPTION_FAILURE_REASONS)] : null;
  return {
    // A subscription charge failure IS a failed payment, so the row's own
    // identity is the charge attempt. subscription_id repeats across cycles.
    payment_id: makeId("pay", rng),
    subscription_id: subscriptionId,
    customer_id: customer.customer_id,
    plan_id: planId,
    plan_amount: plan.plan_amount,
    plan_period: plan.plan_period,
    plan_interval: plan.plan_interval,
    paid_count: cycleNumber,
    total_count: plan.total_count,
    status,
    method: rng.pick(PAYMENT_METHODS),
    error_code: error?.error_code ?? null,
    error_description: error?.error_description ?? null,
    created_at: isoAt(timestampMs),
  };
}

const TERMINAL_DISPUTE_STATUSES = new Set<DisputeEvent["status"]>(["won", "lost", "closed"]);

// resolved_at is non-null exactly for the terminal statuses, and always
// strictly after dispute_created_at. `resolvedAfterDays` overrides the
// default lag (fractional days allowed) where a scenario needs the
// resolution to land at a specific point relative to a later event.
//
// A resolution can fall beyond SIM_NOW: that is a dispute this batch never
// observes resolving, and under asOf scoping it correctly reads as
// unresolved at every decision point in the run.
function makeDisputeEvent(
  rng: Rng,
  customer: Customer,
  timestampMs: number,
  status: DisputeEvent["status"],
  opts?: { orderId?: string; resolvedAfterDays?: number },
): DisputeEvent {
  const resolved = TERMINAL_DISPUTE_STATUSES.has(status);
  const resolvedAfterDays = opts?.resolvedAfterDays ?? (resolved ? rng.int(7, 45) : 0);
  return {
    dispute_id: makeId("dispute", rng),
    customer_id: customer.customer_id,
    payment_id: makeId("pay", rng),
    order_id: opts?.orderId ?? makeId("order", rng),
    amount: rng.int(5, 80) * 10_000,
    dispute_reason: rng.pick(DISPUTE_REASONS),
    dispute_created_at: isoAt(timestampMs),
    resolved_at: resolved ? isoAt(timestampMs + Math.max(1, Math.round(resolvedAfterDays * DAY_MS))) : null,
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
    // Razorpay 'lost' = the merchant lost or accepted the chargeback and the
    // customer was refunded. That is the CLEAN outcome for this scenario: it
    // says nothing against the customer, so a "normal" customer reads as
    // disputeCautionLevel "none". (Razorpay 'won' would mean the merchant
    // successfully contested them — the customer-adverse outcome — which is
    // the opposite of what "one clean event, resolves fine" means. This
    // literal was 'won' while the mapping was inverted.)
    batch.disputeEvents.push(makeDisputeEvent(rng, customer, ts, "lost"));
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
// stopping rule material (use paid_count to trace it).
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
function generateCrossDomainRisk(rng: Rng, customer: Customer, batch: SyntheticBatch): ScenarioAnnotation {
  const paidTs = daysAgo(EVENT_WINDOW_DAYS - rng.int(0, 20));
  const paidEvent = makeCartAbandonmentEvent(rng, customer, paidTs, "paid");
  batch.cartAbandonmentEvents.push(paidEvent);

  const disputeTs = paidTs + rng.int(2, 14) * DAY_MS;
  const laterCartTs = Math.min(disputeTs + rng.int(5, 30) * DAY_MS, SIM_NOW);

  // A terminal dispute must be RESOLVED by the time the later cart fires, not
  // merely filed. Under the asOf rules in profile.ts a dispute counts as
  // resolved only once resolved_at <= asOf, and a visible-but-unresolved
  // dispute is deliberately treated as `unresolved` no matter what its
  // eventual status says. With the default 7-45 day resolution lag a `lost`
  // or `won` dispute would frequently still read as unresolved at the later
  // cart, collapsing all three variants below into the same signal. Resolve
  // strictly inside the gap instead.
  const gapDays = Math.max(1, Math.floor((laterCartTs - disputeTs) / DAY_MS));
  const resolvedAfterDays = gapDays >= 2 ? rng.int(1, gapDays - 1) : 1;

  // Three outcomes at equal weight, and the merchant-conceded arm is the one
  // that makes this scenario a real test rather than a one-sided one. Same
  // event shape in every arm — paid order, dispute on it, later abandoned
  // cart — so the ONLY thing that differs is how the dispute turned out.
  //
  // Razorpay's status words describe how it went for the MERCHANT, which is
  // the opposite of the intuitive reading (see DisputeBreakdown in
  // types/memory.ts):
  //   'won'        -> merchant contested successfully; the complaint did not
  //                   hold up -> "adverse"    -> should suppress
  //   'under_review' -> no ruling yet          -> "unresolved" -> should suppress
  //   'lost'       -> merchant lost or accepted the chargeback; the customer
  //                   was refunded             -> "none"       -> should NOT suppress
  // Without that last arm, "memory suppresses discounts after a dispute" is
  // unfalsifiable: a system that suppressed on any dispute at all would score
  // identically to one that reads the outcome.
  const disputeOutcome = rng.pick(["under_review", "lost", "won"] as const);
  batch.disputeEvents.push(
    makeDisputeEvent(rng, customer, disputeTs, disputeOutcome, {
      orderId: paidEvent.order_id,
      resolvedAfterDays,
    }),
  );

  batch.cartAbandonmentEvents.push(
    makeCartAbandonmentEvent(rng, customer, laterCartTs, rng.pick(["created", "attempted"] as const)),
  );

  return { dispute_outcome: disputeOutcome };
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
    batch.cartAbandonmentEvents.push({
      ...event,
      amount: 0,
      amount_paid: 0,
      amount_due: 0,
      notes: { ...event.notes, items: 0 },
    });
    return;
  }
  if (variant === 2) {
    // Contradictory subscription state: active status but a payment error set.
    const planCode = planCodeFor(customer);
    const ts = randomTimestampWithinWindow(rng);
    const event = makeSubscriptionCycleEvent(rng, customer, makeId("sub", rng), makeId("plan", rng), planCode, 1, ts, "active");
    batch.subscriptionFailureEvents.push({
      ...event,
      ...SUBSCRIPTION_ERROR_BY_REASON[rng.pick(SUBSCRIPTION_FAILURE_REASONS)],
    });
    return;
  }
  if (variant === 3) {
    // Dispute closed implausibly fast (within an hour of being filed), for an
    // unusually large amount. Previously this closed at the same instant it
    // was created; resolved_at must be strictly after dispute_created_at, so
    // the "impossibly fast" character is kept as a one-hour lag instead of a
    // zero-length one.
    const ts = randomTimestampWithinWindow(rng);
    const event = makeDisputeEvent(rng, customer, ts, "closed", { resolvedAfterDays: 1 / 24 });
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
  generate: (rng: Rng, customer: Customer, batch: SyntheticBatch) => ScenarioAnnotation | void;
}

// The mix is deliberately weighted toward customers who generate MULTIPLE cart
// events (repeat_offender_cart, cross_domain_risk), well above what a real
// merchant's traffic looks like. The experimentation layer's moderator split is
// on prior discount history, and under asOf scoping a customer's first cart
// event always has an empty history — so only multi-cart customers can ever
// reach the prior_discount bucket, and only then if the coin actually assigned
// the discount arm on an earlier event. At a realistic mix that bucket lands in
// single digits and supports no claim at all, even a directional one.
//
// This is a demo-scale sampling choice, not an assertion about real merchant
// traffic: if anything, it OVER-represents repeat abandoners. It changes how
// many customers land in each scenario, never what a scenario produces — the
// per-scenario generators below are what make the memory layer's findings
// meaningful and are unchanged.
const SCENARIO_BUCKETS: ScenarioBucket[] = [
  { scenario: "normal", weight: 0.4, note: "one clean, resolved event", generate: generateNormal },
  {
    scenario: "repeat_offender_cart",
    weight: 0.2,
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
    weight: 0.15,
    note: "a dispute on a past order, then a later cart — whether the discount should be suppressed depends on how the dispute resolved",
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
    // Label is written AFTER generation so it can carry whatever the
    // generator learned while planting the customer (currently the
    // cross_domain_risk dispute outcome). Generation consumes the same RNG
    // draws either way, so the batch is unchanged by the reordering.
    const annotation = generatorByScenario.get(scenario)!.generate(rng, customer, batch) ?? {};
    batch.scenarioLabels.push({
      customer_id: customer.customer_id,
      scenario,
      note: noteByScenario.get(scenario) ?? "",
      ...annotation,
    });
  }

  return batch;
}

export function summarizeBatch(batch: SyntheticBatch) {
  const scenarioCounts: Record<string, number> = {};
  for (const label of batch.scenarioLabels) {
    scenarioCounts[label.scenario] = (scenarioCounts[label.scenario] ?? 0) + 1;
  }
  // Customers with 2+ cart events are the only ones who can ever reach the
  // experimentation layer's prior_discount moderator bucket (a first cart event
  // always sees an empty discount history under asOf scoping), so this count —
  // read against cartAbandonmentEvents — is what says whether the experiment
  // has the population to support a directional claim.
  const cartEventsPerCustomer = new Map<string, number>();
  for (const event of batch.cartAbandonmentEvents) {
    cartEventsPerCustomer.set(event.customer_id, (cartEventsPerCustomer.get(event.customer_id) ?? 0) + 1);
  }
  let customersWithMultipleCartEvents = 0;
  for (const count of cartEventsPerCustomer.values()) {
    if (count >= 2) customersWithMultipleCartEvents += 1;
  }

  return {
    customers: batch.customers.length,
    cartAbandonmentEvents: batch.cartAbandonmentEvents.length,
    customersWithMultipleCartEvents,
    subscriptionFailureEvents: batch.subscriptionFailureEvents.length,
    disputeEvents: batch.disputeEvents.length,
    scenarioCounts,
  };
}
