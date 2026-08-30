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
} from "./fixtures.js";

// Fixed reference point so a given seed always reproduces the same batch —
// baseline-vs-memory comparison runs need to diff the same data.
const SIM_NOW = new Date("2026-08-23T00:00:00Z").getTime();
const DAY_MS = 24 * 60 * 60 * 1000;
const SIGNUP_LOOKBACK_DAYS = 730;
const EVENT_WINDOW_DAYS = 120;

// A customer must exist before they can transact. Every scenario draws its
// event timestamps inside EVENT_WINDOW_DAYS of SIM_NOW, so drawing signup
// strictly OUTSIDE that window is what makes "no event predates its own
// customer's signup_date" structural rather than a coincidence.
//
// It was a coincidence, and an unreliable one: signup was drawn 1-730 days
// back while events were drawn 0-120 days back, two completely independent
// draws. 231 of 3,202 events (7.2%, across 105 customers and every scenario)
// landed before their customer signed up, the worst by 115 days — and
// signup_date is rendered directly above the event timeline in the customer
// explorer, so the contradiction was visible in the demo.
//
// The cost is that nobody signs up during the observation window, so the batch
// has no "brand new customer" cohort. That is inherent to giving every customer
// events up to 120 days old; no signal reads signup_date, it is a dashboard
// display field only.
const SIGNUP_MIN_DAYS_AGO = EVENT_WINDOW_DAYS + 1;

// Spacing for cross_agent_gaming, which must NOT also read as composite churn.
// Both bounds must stay strictly above CHURN_LOOKBACK_DAYS (14) in
// agents/signals/thresholds.ts.
//
// The constant is duplicated here rather than imported: thresholds.ts reaches
// into memory/profile.ts and therefore into better-sqlite3, and the data
// generator has no business depending on the decisioning layer or on a DB
// driver. `npm run validate:data` imports both and asserts the relationship
// holds, so the duplication is checked rather than merely commented.
const CHURN_SAFE_GAP_MIN_DAYS = 18;
const CHURN_SAFE_GAP_MAX_DAYS = 25;

// Exported for validate:data, which asserts the gap clears CHURN_LOOKBACK_DAYS.
export const CHURN_SAFE_GAP_DAYS = { min: CHURN_SAFE_GAP_MIN_DAYS, max: CHURN_SAFE_GAP_MAX_DAYS } as const;

// The batch's fixed "now", exported so validators can assert against the same
// instant the generator built the batch around rather than wall-clock time.
export const SIM_NOW_ISO = new Date(SIM_NOW).toISOString();

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

// Day-aligned timestamps meant all 3,202 events in the batch shared a single
// time-of-day (midnight UTC) — the first thing a reader who has seen a real
// payments export would notice, and the reason 47 customers had two events
// colliding at the exact same instant. Under the `<=` as-of filters in
// profile.ts each of a colliding pair saw the other in its own profile.
//
// Always ADDED to a day-aligned point strictly in the past, so a jittered
// timestamp can never cross SIM_NOW. Call sites that derive a timestamp
// arithmetically from another one keep their own SIM_NOW guards.
function timeOfDayOffset(rng: Rng): number {
  return rng.int(0, DAY_MS - 1);
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
    signup_date: isoAt(daysAgo(rng.int(SIGNUP_MIN_DAYS_AGO, SIGNUP_LOOKBACK_DAYS))),
    plan_tier: planTier,
  };
}

function randomDigits(rng: Rng, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += rng.int(0, 9).toString();
  return out;
}

// Draws from day 1 rather than day 0 so the added time-of-day cannot push the
// result past SIM_NOW: the range is (SIM_NOW - windowDays, SIM_NOW).
function randomTimestampWithinWindow(rng: Rng, windowDays = EVENT_WINDOW_DAYS): number {
  return daysAgo(rng.int(1, windowDays)) + timeOfDayOffset(rng);
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
// `amount` overrides the random draw where the dispute is attached to an order
// this batch actually contains, because a chargeback cannot exceed what was
// charged. Passing `orderId` alone used to wire up one half of that
// relationship and leave the amount independently random: 178 of 180
// cross-domain disputes disagreed with the order they pointed at, 132 of them
// exceeding it, one by 13x. total_disputed_amount and adverse_disputed_amount
// are sent to the model as magnitudes, so that number reaches a real decision.
//
// Disputes with no `orderId` reference an order outside this batch's export
// window and keep the independent draw — there is nothing to reconcile against.
function makeDisputeEvent(
  rng: Rng,
  customer: Customer,
  timestampMs: number,
  status: DisputeEvent["status"],
  opts?: { orderId?: string; amount?: number; resolvedAfterDays?: number },
): DisputeEvent {
  const resolved = TERMINAL_DISPUTE_STATUSES.has(status);
  const resolvedAfterDays = opts?.resolvedAfterDays ?? (resolved ? rng.int(7, 45) : 0);
  return {
    dispute_id: makeId("dispute", rng),
    customer_id: customer.customer_id,
    payment_id: makeId("pay", rng),
    order_id: opts?.orderId ?? makeId("order", rng),
    amount: opts?.amount ?? rng.int(5, 80) * 10_000,
    dispute_reason: rng.pick(DISPUTE_REASONS),
    dispute_created_at: isoAt(timestampMs),
    resolved_at: resolved ? isoAt(timestampMs + Math.max(1, Math.round(resolvedAfterDays * DAY_MS))) : null,
    status,
  };
}

function planCodeFor(customer: Customer): PlanCode {
  return customer.plan_tier;
}

// One recovery-eligible event, in a single domain, for a customer with no other
// history. The negative control: a real recovery opportunity where memory has
// nothing to say, so both arms should reach the same decision.
//
// TWO constraints make this cohort actually quiet, and both were learned by
// getting it wrong:
//
// 1. CART OR SUBSCRIPTION ONLY. This used to include an unresolved dispute as a
//    third domain, which fired disputeCautionWarranted and tightened the memory
//    arm's cap to 15% or 10% while the baseline stayed at the 20% default — so
//    roughly a third of the control diverged between arms by construction. A
//    control cohort exists to show the arms AGREE where there is no adverse
//    history; it cannot show that if part of it disagrees. Dispute-agent
//    coverage comes from repeat_offender_dispute and cross_domain_risk, which
//    are built for it.
//
// 2. paid_count IS PINNED TO 1. successful_payment_count reads the paid_count
//    of a subscription's latest row (readPaymentHistory in profile.ts), so a
//    cycle drawn with paid_count >= MIN_SUCCESSFUL_PAYMENTS would fire
//    provenPayer and widen the memory arm's cap to 25% — the same divergence as
//    (1), arriving from the subscription side instead. One prior successful
//    charge followed by a failure is both quiet and the ordinary shape of a
//    first billing failure.
//
// Before this scenario emitted the CLEAN terminal state of each domain — a paid
// cart, an active cycle, a conceded dispute. All three are ineligible for a
// decision, so the entire control cohort would have vanished from the
// comparison once the runner started filtering. What makes it a control is the
// absence of HISTORY, not the absence of a recovery question.
function generateNormal(rng: Rng, customer: Customer, batch: SyntheticBatch): void {
  const domain = rng.pick(["cart", "subscription"] as const);
  const ts = randomTimestampWithinWindow(rng);

  if (domain === "cart") {
    batch.cartAbandonmentEvents.push(
      makeCartAbandonmentEvent(rng, customer, ts, rng.pick(["created", "attempted"] as const)),
    );
  } else {
    const planCode = planCodeFor(customer);
    batch.subscriptionFailureEvents.push(
      makeSubscriptionCycleEvent(rng, customer, makeId("sub", rng), makeId("plan", rng), planCode, 1, ts, "failed"),
    );
  }
}



// Repeated abandoned carts for one customer, converting only occasionally.
// Drives cart recovery_frequency past MAX_DISCOUNT_ATTEMPTS_PER_AGENT, so it is
// the per-agent gamingSuspected and discount stopping-rule target.
function generateRepeatOffenderCart(rng: Rng, customer: Customer, batch: SyntheticBatch): void {
  const cycles = rng.int(4, 7);
  const timestamps = Array.from({ length: cycles }, () => randomTimestampWithinWindow(rng)).sort((a, b) => a - b);
  for (const ts of timestamps) {
    const status = rng.chance(0.15) ? "paid" : rng.pick(["created", "attempted"] as const);
    batch.cartAbandonmentEvents.push(makeCartAbandonmentEvent(rng, customer, ts, status));
  }
}

// One subscription failing across consecutive billing cycles, spaced roughly a
// month apart, with a chance the last cycle halts. The subscription-side
// equivalent of the repeat cart abandoner; paid_count traces the cycle.
function generateRepeatOffenderSubscription(rng: Rng, customer: Customer, batch: SyntheticBatch): void {
  const planCode = planCodeFor(customer);
  const subscriptionId = makeId("sub", rng);
  const planId = makeId("plan", rng);
  const failureCycles = rng.int(4, 6);
  const cycleGapDays = Math.floor((EVENT_WINDOW_DAYS - 5) / failureCycles);
  let ts = daysAgo(EVENT_WINDOW_DAYS);
  for (let cycle = 1; cycle <= failureCycles; cycle++) {
    // Jitter is added to the cycle's own timestamp rather than accumulated into
    // `ts`, so it cannot drift the billing cadence across cycles.
    const cycleGap = rng.int(cycleGapDays - 3, cycleGapDays + 3) * DAY_MS;
    ts = Math.min(ts + cycleGap, SIM_NOW);
    const status = cycle === failureCycles && rng.chance(0.4) ? "halted" : "failed";
    batch.subscriptionFailureEvents.push(
      makeSubscriptionCycleEvent(
        rng,
        customer,
        subscriptionId,
        planId,
        planCode,
        cycle,
        Math.min(ts + timeOfDayOffset(rng), SIM_NOW),
        status,
      ),
    );
  }
}

// Several disputes filed against unrelated payments, in a mix of live and
// ruled states. The main source of customer_adverse (Razorpay 'won') outcomes.
function generateRepeatOffenderDispute(rng: Rng, customer: Customer, batch: SyntheticBatch): void {
  const disputes = rng.int(3, 5);
  const timestamps = Array.from({ length: disputes }, () => randomTimestampWithinWindow(rng)).sort((a, b) => a - b);
  for (const ts of timestamps) {
    const status = rng.pick(["open", "under_review", "won", "lost"] as const);
    batch.disputeEvents.push(makeDisputeEvent(rng, customer, ts, status));
  }
}

// A paid order, a dispute filed against that same order, then a later abandoned
// cart. The shared order_id is the cross-domain join, and whether the later
// discount SHOULD be suppressed depends entirely on how the dispute resolved.
function generateCrossDomainRisk(rng: Rng, customer: Customer, batch: SyntheticBatch): ScenarioAnnotation {
  const paidTs = daysAgo(EVENT_WINDOW_DAYS - rng.int(0, 20)) + timeOfDayOffset(rng);
  const paidEvent = makeCartAbandonmentEvent(rng, customer, paidTs, "paid");
  batch.cartAbandonmentEvents.push(paidEvent);

  // Each step is at least 2 days on from the last, so an independently drawn
  // sub-day offset can never reorder the chain.
  const disputeTs = paidTs + rng.int(2, 14) * DAY_MS + timeOfDayOffset(rng);
  const laterCartTs = Math.min(disputeTs + rng.int(5, 30) * DAY_MS + timeOfDayOffset(rng), SIM_NOW);

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
      // The chargeback is against that order, so it is that order's value.
      // Partial chargebacks exist in reality; the full amount is the dominant
      // case and keeps "dispute amount == disputed order amount" checkable.
      amount: paidEvent.amount,
      resolvedAfterDays,
    }),
  );

  batch.cartAbandonmentEvents.push(
    makeCartAbandonmentEvent(rng, customer, laterCartTs, rng.pick(["created", "attempted"] as const)),
  );

  return { dispute_outcome: disputeOutcome };
}

// Two or three domains firing inside a single fortnight — the composite churn
// pattern, which should escalate to a person rather than draw more automated
// nudges from each agent separately.
function generateChurnSignal(rng: Rng, customer: Customer, batch: SyntheticBatch): void {
  // Window starts at day 11, not day 10: an event sits up to 10 days past the
  // start, so day 10 plus a sub-day offset would land in the future. The
  // 11-day maximum spread is unchanged, and still inside CHURN_LOOKBACK_DAYS.
  const windowStart = daysAgo(rng.int(11, EVENT_WINDOW_DAYS - 14));
  const domains = rng.chance(0.3)
    ? (["cart", "subscription", "dispute"] as const)
    : rng.shuffle(["cart", "subscription", "dispute"] as const).slice(0, 2);

  for (const domain of domains) {
    const ts = windowStart + rng.int(0, 10) * DAY_MS + timeOfDayOffset(rng);
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

// A customer with a real payment history who then abandons one cart. Exists to
// exercise the ACCELERATOR path cleanly: provenPayer must fire and no brake may.
//
// The successes are split across carts and subscription cycles so the "across
// all domains" half of provenPayer is actually exercised rather than assumed.
// Note how successful_payment_count is computed (readPaymentHistory in
// profile.ts): paid carts count one each, but a subscription contributes the
// `paid_count` of its LATEST row as of the read, not one per row. Incrementing
// paid_count per cycle therefore makes the subscription contribute exactly its
// cycle count.
//
// Deliberately carries no disputes and no failed cycles, because every brake is
// reachable from those: a dispute would trip disputeCautionLevel, and failed
// cycles would feed recovery_frequency. The single trailing abandoned cart puts
// cart recovery_frequency at 1 — below MAX_DISCOUNT_ATTEMPTS_PER_AGENT — and
// total recovery at 1, below MAX_TOTAL_RECOVERY_EVENTS_ACROSS_AGENTS. With only
// one domain in recent_events, composite churn cannot fire either.
function generateLoyalPayer(rng: Rng, customer: Customer, batch: SyntheticBatch): void {
  const successes = rng.int(3, 5);
  // At least one of each, so the successes always span two domains.
  const paidCarts = rng.int(1, successes - 1);
  const paidCycles = successes - paidCarts;

  let ts = daysAgo(EVENT_WINDOW_DAYS - rng.int(0, 10));
  const step = (): number => {
    ts = ts + rng.int(2, 12) * DAY_MS;
    return Math.min(ts + timeOfDayOffset(rng), SIM_NOW);
  };

  for (let i = 0; i < paidCarts; i++) {
    batch.cartAbandonmentEvents.push(makeCartAbandonmentEvent(rng, customer, step(), "paid"));
  }

  const subscriptionId = makeId("sub", rng);
  const planId = makeId("plan", rng);
  const planCode = planCodeFor(customer);
  for (let cycle = 1; cycle <= paidCycles; cycle++) {
    batch.subscriptionFailureEvents.push(
      makeSubscriptionCycleEvent(rng, customer, subscriptionId, planId, planCode, cycle, step(), "active"),
    );
  }

  // The triggering event: one abandonment, after every success.
  batch.cartAbandonmentEvents.push(
    makeCartAbandonmentEvent(rng, customer, step(), rng.pick(["created", "attempted"] as const)),
  );
}

// A customer who is BOTH an established payer and a heavy abandoner. Exists to
// exercise precedence in resolveSignalEffects: gamingSuspected (brake) and
// provenPayer (accelerator) are true simultaneously at the final event, and the
// brake must win regardless of registry order.
//
// Everything is a cart event, which keeps the scenario honest about what it
// tests. recent_events only ever sees one domain, so composite churn cannot
// fire and confound the reading; and the paid carts feed
// successful_payment_count without also feeding recovery_frequency, since that
// counts non-paid carts only.
function generateConflictedCustomer(rng: Rng, customer: Customer, batch: SyntheticBatch): void {
  const abandoned = rng.int(4, 6);
  const paid = rng.int(2, 3);

  // The final event must be an abandoned cart, so it is held back from the
  // shuffle rather than left to chance.
  const leading: CartAbandonmentEvent["status"][] = [
    ...Array.from({ length: paid }, () => "paid" as const),
    ...Array.from({ length: abandoned - 1 }, () => rng.pick(["created", "attempted"] as const)),
  ];
  const order = [...rng.shuffle(leading), rng.pick(["created", "attempted"] as const)];

  let ts = daysAgo(EVENT_WINDOW_DAYS - rng.int(0, 10));
  for (const status of order) {
    ts = ts + rng.int(2, 10) * DAY_MS;
    batch.cartAbandonmentEvents.push(
      makeCartAbandonmentEvent(rng, customer, Math.min(ts + timeOfDayOffset(rng), SIM_NOW), status),
    );
  }
}

// The pattern crossAgentGamingSuspected was written for: recovery flows
// triggered across every agent, with no single agent reaching its own
// MAX_DISCOUNT_ATTEMPTS_PER_AGENT threshold. 2 carts + 2 failed cycles + 1
// dispute puts the per-agent counts at 2/2/1 and the total at
// MAX_TOTAL_RECOVERY_EVENTS_ACROSS_AGENTS, so per-agent gamingSuspected stays
// silent and only the cross-agent signal fires.
//
// Events are spaced strictly wider than CHURN_LOOKBACK_DAYS. Composite churn
// asks whether 2+ domains fired within a fortnight; this scenario's claim is
// dispersion ACROSS AGENTS, not concentration in time. If churn also fired, the
// scenario would prove nothing the churn scenario does not already prove.
//
// The two failed cycles hold paid_count at 1 rather than incrementing it. That
// is both the correct Razorpay reading — paid_count counts SUCCESSFUL charges,
// which do not increase when a charge fails — and what keeps
// successful_payment_count below MIN_SUCCESSFUL_PAYMENTS, so provenPayer stays
// out of this scenario and the cross-agent brake is read in isolation.
function generateCrossAgentGaming(rng: Rng, customer: Customer, batch: SyntheticBatch): void {
  const subscriptionId = makeId("sub", rng);
  const planId = makeId("plan", rng);
  const planCode = planCodeFor(customer);

  // Ordered so the triggering event is a cart, and every gap exceeds
  // CHURN_LOOKBACK_DAYS.
  const sequence = ["cart", "subscription", "dispute", "subscription", "cart"] as const;

  let ts = daysAgo(EVENT_WINDOW_DAYS);
  for (const domain of sequence) {
    ts = ts + rng.int(CHURN_SAFE_GAP_MIN_DAYS, CHURN_SAFE_GAP_MAX_DAYS) * DAY_MS;
    const at = Math.min(ts + timeOfDayOffset(rng), SIM_NOW);

    if (domain === "cart") {
      batch.cartAbandonmentEvents.push(
        makeCartAbandonmentEvent(rng, customer, at, rng.pick(["created", "attempted"] as const)),
      );
    } else if (domain === "subscription") {
      batch.subscriptionFailureEvents.push(
        makeSubscriptionCycleEvent(rng, customer, subscriptionId, planId, planCode, 1, at, "failed"),
      );
    } else {
      batch.disputeEvents.push(makeDisputeEvent(rng, customer, at, rng.pick(["open", "under_review"] as const)));
    }
  }
}

// Edge cases agents must handle without falling over.
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
  const cartTs = daysAgo(EVENT_WINDOW_DAYS) + timeOfDayOffset(rng);
  const subTs = daysAgo(5) + timeOfDayOffset(rng);
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
  { scenario: "normal", weight: 0.24, note: "a single recovery-eligible event, no other history — the negative control", generate: generateNormal },
  {
    scenario: "repeat_offender_cart",
    weight: 0.15,
    note: "repeated abandoned carts — gaming/stopping-rule target",
    generate: generateRepeatOffenderCart,
  },
  {
    scenario: "cross_domain_risk",
    weight: 0.17,
    note: "a dispute on a past order, then a later cart — whether the discount should be suppressed depends on how the dispute resolved",
    generate: generateCrossDomainRisk,
  },
  {
    scenario: "churn_signal",
    weight: 0.09,
    note: "2+ domains in a tight window — should escalate to human",
    generate: generateChurnSignal,
  },
  {
    scenario: "loyal_payer",
    weight: 0.08,
    note: "established payer, one abandonment — the accelerator path with no brake active",
    generate: generateLoyalPayer,
  },
  {
    scenario: "conflicted_customer",
    weight: 0.07,
    note: "heavy abandoner who also pays — brake and accelerator true at once",
    generate: generateConflictedCustomer,
  },
  {
    scenario: "cross_agent_gaming",
    weight: 0.06,
    note: "recovery triggers spread across all three agents, none reaching its own threshold",
    generate: generateCrossAgentGaming,
  },
  {
    scenario: "repeat_offender_subscription",
    weight: 0.045,
    note: "repeated billing-cycle failures — gaming/stopping-rule target",
    generate: generateRepeatOffenderSubscription,
  },
  {
    scenario: "repeat_offender_dispute",
    weight: 0.045,
    note: "repeat dispute filer",
    generate: generateRepeatOffenderDispute,
  },
  { scenario: "noise", weight: 0.05, note: "edge case / malformed-ish data", generate: generateNoise },
];

// Derived from SCENARIO_BUCKETS rather than restated, so a validator checking
// realised counts against configured weights cannot be checking against a
// second, stale copy of those weights.
// Asserted at module load, not by inspection: a previous reweight was specified
// with values summing to 1.04 and the error was caught only by hand-adding the
// column. allocateCounts gives the final bucket whatever is left over, so a bad
// sum does not throw — it silently distorts that one bucket instead.
const WEIGHT_SUM = SCENARIO_BUCKETS.reduce((total, b) => total + b.weight, 0);
if (Math.abs(WEIGHT_SUM - 1) > 1e-9) {
  throw new Error(
    `SCENARIO_BUCKETS weights must sum to exactly 1.0, got ${WEIGHT_SUM}. ` +
      `The last bucket silently absorbs any discrepancy, so this must fail loudly instead.`,
  );
}

export const SCENARIO_WEIGHTS: Record<Scenario, number> = Object.fromEntries(
  SCENARIO_BUCKETS.map((b) => [b.scenario, b.weight]),
) as Record<Scenario, number>;

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
