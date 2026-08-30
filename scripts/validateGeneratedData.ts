// Standalone hygiene + reachability assertions over data/generated/.
//
// Run after `npm run generate:data`. Reads only the emitted JSON — it does not
// need the DB loaded, and it makes no API calls. Exits non-zero on the first
// failing assertion class, printing the offending record ids so a failure is
// actionable rather than merely red.
//
// Two kinds of assertion live here:
//
//   HYGIENE      — properties that must hold of any batch, and that have each
//                  been violated at least once in this project's history.
//   REACHABILITY — properties that must hold of the scenarios written to
//                  populate specific signals. A scenario that stops reaching
//                  its signal is silently useless; these make that loud.
//
// Thresholds are IMPORTED rather than restated, so the assertions cannot drift
// away from the policy they are checking. The aggregation below deliberately
// MIRRORS memory/profile.ts (readRecoveryFrequency and readPaymentHistory);
// where it does, the mirroring is called out so the two can be diffed by hand.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CartAbandonmentEvent,
  Customer,
  DisputeEvent,
  SubscriptionFailureEvent,
} from "../src/types/index.js";
import type { Scenario, ScenarioLabel } from "../src/data/generator.js";
import { openDb } from "../src/db/connection.js";
import { computeMemoryProfile } from "../src/memory/profile.js";
import { computeMemorySignals } from "../src/agents/signals/index.js";
import type { TriggeringEventFacts } from "../src/agents/signals/types.js";
import { SCENARIO_WEIGHTS, SIM_NOW_ISO, CHURN_SAFE_GAP_DAYS } from "../src/data/generator.js";
import {
  CHURN_LOOKBACK_DAYS,
  MAX_DISCOUNT_ATTEMPTS_PER_AGENT,
  MAX_TOTAL_RECOVERY_EVENTS_ACROSS_AGENTS,
  MIN_SUCCESSFUL_PAYMENTS,
} from "../src/agents/signals/thresholds.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIR = join(__dirname, "..", "data", "generated");
const read = <T>(f: string): T => JSON.parse(readFileSync(join(DIR, f), "utf-8")) as T;

const customers = read<Customer[]>("customers.json");
const carts = read<CartAbandonmentEvent[]>("cart_abandonment_events.json");
const subs = read<SubscriptionFailureEvent[]>("subscription_failure_events.json");
const disputes = read<DisputeEvent[]>("dispute_events.json");
const labels = read<ScenarioLabel[]>("scenario_labels.json");

const customerById = new Map(customers.map((c) => [c.customer_id, c]));
const scenarioOf = new Map(labels.map((l) => [l.customer_id, l.scenario]));
const cartByOrderId = new Map(carts.map((c) => [c.order_id, c]));

// How many sample ids to print alongside a failure. Enough to start debugging,
// few enough that a systemic failure does not bury the summary.
const SAMPLE = 5;

let failures = 0;
function assert(name: string, offenders: string[], detail?: string): void {
  if (offenders.length === 0) {
    console.log(`  PASS  ${name}`);
    return;
  }
  failures += 1;
  const shown = offenders.slice(0, SAMPLE).join(", ");
  const more = offenders.length > SAMPLE ? ` (+${offenders.length - SAMPLE} more)` : "";
  console.log(`  FAIL  ${name} — ${offenders.length} violation(s)`);
  if (detail) console.log(`          ${detail}`);
  console.log(`          ${shown}${more}`);
}

// One row per event, normalised so the whole-batch assertions can run over a
// single list regardless of which table an event came from.
interface AnyEvent {
  id: string;
  customerId: string;
  at: string;
  domain: "cart" | "subscription" | "dispute";
}
const events: AnyEvent[] = [
  ...carts.map((c) => ({ id: c.order_id, customerId: c.customer_id, at: c.created_at, domain: "cart" as const })),
  ...subs.map((s) => ({
    id: s.payment_id,
    customerId: s.customer_id,
    at: s.created_at,
    domain: "subscription" as const,
  })),
  ...disputes.map((d) => ({
    id: d.dispute_id,
    customerId: d.customer_id,
    at: d.dispute_created_at,
    domain: "dispute" as const,
  })),
];

console.log(`\nvalidate:data — ${customers.length} customers, ${events.length} events\n`);
console.log("Hygiene");

// The spec for this script called this the customer's `created_at`; the field
// is named signup_date on the Customer type. Same fact, existing name kept.
assert(
  "no event precedes its customer's signup_date",
  events.filter((e) => e.at < (customerById.get(e.customerId)?.signup_date ?? "")).map((e) => e.id),
);

assert(
  "no event is timestamped after SIM_NOW",
  events.filter((e) => e.at > SIM_NOW_ISO).map((e) => e.id),
  `SIM_NOW = ${SIM_NOW_ISO}`,
);

// Only disputes that join to an order IN THIS BATCH are checkable. A dispute
// pointing outside the export window has nothing to reconcile against.
const joinable = disputes.filter((d) => cartByOrderId.has(d.order_id));
assert(
  "a dispute on an order in this batch carries that order's amount",
  joinable.filter((d) => d.amount !== cartByOrderId.get(d.order_id)!.amount).map((d) => d.dispute_id),
  `${joinable.length} of ${disputes.length} disputes join to an order in this batch`,
);

const TERMINAL = new Set(["won", "lost", "closed"]);
assert(
  "a terminal dispute resolves strictly after it was filed",
  disputes
    .filter((d) => TERMINAL.has(d.status))
    .filter((d) => !d.resolved_at || d.resolved_at <= d.dispute_created_at)
    .map((d) => d.dispute_id),
);

// A missing timeOfDayOffset shows up as a pile-up in the midnight hour. The
// bound is loose on purpose: this catches a regression, it does not police the
// shape of the distribution.
const MIDNIGHT_HOUR_MAX_SHARE = 0.1;
const midnight = events.filter((e) => e.at.slice(11, 13) === "00");
const midnightShare = midnight.length / events.length;
assert(
  `under ${(MIDNIGHT_HOUR_MAX_SHARE * 100).toFixed(0)}% of events fall in the midnight hour`,
  midnightShare >= MIDNIGHT_HOUR_MAX_SHARE ? midnight.slice(0, SAMPLE).map((e) => e.id) : [],
  `observed ${(midnightShare * 100).toFixed(1)}% (${midnight.length}/${events.length})`,
);

// Identical timestamps within one customer make two events indistinguishable in
// time; under the `<=` as-of filters each then appears in the other's profile.
const seen = new Map<string, string>();
const collisions: string[] = [];
for (const e of events) {
  const key = `${e.customerId}|${e.at}`;
  const prior = seen.get(key);
  if (prior) collisions.push(`${prior}+${e.id}`);
  else seen.set(key, e.id);
}
assert("no two events for one customer share a timestamp", collisions);

// --- Per-customer aggregates, MIRRORING memory/profile.ts -------------------
// readRecoveryFrequency: non-paid carts, failed/halted cycles, ALL disputes.
// readPaymentHistory:    paid carts, plus the paid_count of the LATEST row per
//                        subscription (earlier rows are stale lower counts).
interface Agg {
  cart: number;
  subscription: number;
  dispute: number;
  successfulPayments: number;
}
const agg = new Map<string, Agg>();
const of = (id: string): Agg =>
  agg.get(id) ?? (agg.set(id, { cart: 0, subscription: 0, dispute: 0, successfulPayments: 0 }), agg.get(id)!);

for (const c of carts) {
  if (c.status === "paid") of(c.customer_id).successfulPayments += 1;
  else of(c.customer_id).cart += 1;
}
for (const d of disputes) of(d.customer_id).dispute += 1;

const latestPerSub = new Map<string, SubscriptionFailureEvent>();
for (const s of subs) {
  if (s.status === "failed" || s.status === "halted") of(s.customer_id).subscription += 1;
  const prior = latestPerSub.get(s.subscription_id);
  if (!prior || s.created_at > prior.created_at) latestPerSub.set(s.subscription_id, s);
}
for (const s of latestPerSub.values()) of(s.customer_id).successfulPayments += s.paid_count;

const totalRecovery = (a: Agg): number => a.cart + a.subscription + a.dispute;
const idsIn = (scenario: Scenario): string[] =>
  labels.filter((l) => l.scenario === scenario).map((l) => l.customer_id);

// Reachability is asserted at 90% rather than 100%: these scenarios draw their
// event counts from ranges, so a small tail can legitimately sit at the
// boundary. Below 90% the scenario has stopped doing its job.
const MIN_REACH = 0.9;
function assertReach(name: string, ids: string[], holds: (a: Agg) => boolean): void {
  const bad = ids.filter((id) => !holds(of(id)));
  const rate = ids.length ? (ids.length - bad.length) / ids.length : 1;
  assert(
    `${name} (>= ${(MIN_REACH * 100).toFixed(0)}%)`,
    rate >= MIN_REACH ? [] : bad,
    `${((1 - bad.length / Math.max(ids.length, 1)) * 100).toFixed(1)}% of ${ids.length} customers satisfy it`,
  );
}

console.log("\nSignal reachability");

assertReach(
  `loyal_payer reaches provenPayer (>= ${MIN_SUCCESSFUL_PAYMENTS} payments) with no dispute`,
  idsIn("loyal_payer"),
  (a) => a.successfulPayments >= MIN_SUCCESSFUL_PAYMENTS && a.dispute === 0,
);

assertReach(
  `cross_agent_gaming reaches the cross-agent total (>= ${MAX_TOTAL_RECOVERY_EVENTS_ACROSS_AGENTS}) ` +
    `with no single agent at ${MAX_DISCOUNT_ATTEMPTS_PER_AGENT}`,
  idsIn("cross_agent_gaming"),
  (a) =>
    totalRecovery(a) >= MAX_TOTAL_RECOVERY_EVENTS_ACROSS_AGENTS &&
    a.cart < MAX_DISCOUNT_ATTEMPTS_PER_AGENT &&
    a.subscription < MAX_DISCOUNT_ATTEMPTS_PER_AGENT &&
    a.dispute < MAX_DISCOUNT_ATTEMPTS_PER_AGENT,
);

assertReach(
  "conflicted_customer satisfies the gaming brake and the proven-payer accelerator at once",
  idsIn("conflicted_customer"),
  (a) => a.cart >= MAX_DISCOUNT_ATTEMPTS_PER_AGENT && a.successfulPayments >= MIN_SUCCESSFUL_PAYMENTS,
);

// The generator duplicates CHURN_LOOKBACK_DAYS rather than importing it (that
// import would drag better-sqlite3 into the data layer). This is the check that
// makes the duplication safe.
assert(
  `cross_agent_gaming event spacing stays above CHURN_LOOKBACK_DAYS (${CHURN_LOOKBACK_DAYS})`,
  CHURN_SAFE_GAP_DAYS.min > CHURN_LOOKBACK_DAYS ? [] : ["CHURN_SAFE_GAP_DAYS.min"],
  `generator gap is ${CHURN_SAFE_GAP_DAYS.min}-${CHURN_SAFE_GAP_DAYS.max} days`,
);

console.log("\nScenario distribution");

// Realised share must track the configured weight. Tolerance is in percentage
// POINTS of the total population.
const DISTRIBUTION_TOLERANCE_PP = 2;
const realised = new Map<string, number>();
for (const l of labels) realised.set(l.scenario, (realised.get(l.scenario) ?? 0) + 1);

const drifted: string[] = [];
for (const [scenario, weight] of Object.entries(SCENARIO_WEIGHTS)) {
  const n = realised.get(scenario) ?? 0;
  const sharePp = (n / labels.length) * 100;
  const targetPp = weight * 100;
  const delta = Math.abs(sharePp - targetPp);
  console.log(
    `        ${scenario.padEnd(30)} n=${String(n).padStart(4)}  ` +
      `${sharePp.toFixed(1)}% vs ${targetPp.toFixed(1)}% target  (${delta.toFixed(2)}pp)`,
  );
  if (delta > DISTRIBUTION_TOLERANCE_PP) drifted.push(`${scenario}: ${delta.toFixed(2)}pp off`);
}
assert(`every scenario is within ${DISTRIBUTION_TOLERANCE_PP}pp of its configured weight`, drifted);

// --- The control cohort must be silent -------------------------------------
//
// Every other reachability check above runs on a REPLICA of profile.ts's
// aggregation. This one runs the real thing: the actual computeMemoryProfile
// and computeMemorySignals, at each normal customer's real triggering event.
// The control's whole job is to show the two arms agree where there is no
// adverse history, so "no memory signal fires here" is the one property worth
// checking against production code rather than a reimplementation.
//
// paymentFriction is EXCLUDED deliberately. It is the registry's one router and
// it reads the TRIGGERING EVENT, not memory — it fires whenever a cart was
// `attempted` rather than `created`, which is a fact about this event that both
// arms see. It carries no effects, so it cannot move a cap or block a spend and
// cannot make the arms diverge. Asserting it false would mean banning attempted
// carts from the control, which would distort the cohort to satisfy a check.
const MEMORY_DERIVED_DEFAULTS: Record<string, unknown> = {
  disputeCautionWarranted: false,
  disputeCautionLevel: "none",
  discountAttemptsForAgent: 0,
  stoppingRuleHit: false,
  gamingSuspected: false,
  crossAgentGamingSuspected: false,
  compositeChurnSignal: false,
  provenPayer: false,
};

console.log("\nControl-cohort silence (real computeMemorySignals)");

const normalIds = idsIn("normal");
const db = openDb();

// The signals come from the DB, the cohort from the JSON. If load:data has not
// run since generate:data they describe different batches, and a green result
// would be meaningless.
const dbCustomers = (db.prepare("SELECT COUNT(*) AS n FROM customers").get() as { n: number }).n;
if (dbCustomers !== customers.length) {
  console.error(
    `\n  Database holds ${dbCustomers} customers but the generated batch has ${customers.length}.\n` +
      `  Run \`npm run load:data\` so this check reads the batch it is validating.\n`,
  );
  process.exit(1);
}

const cartByCustomer = new Map<string, CartAbandonmentEvent[]>();
for (const c of carts) cartByCustomer.set(c.customer_id, [...(cartByCustomer.get(c.customer_id) ?? []), c]);
const subByCustomer = new Map<string, SubscriptionFailureEvent[]>();
for (const x of subs) subByCustomer.set(x.customer_id, [...(subByCustomer.get(x.customer_id) ?? []), x]);

const noisy: string[] = [];
let evaluated = 0;
let paymentFrictionCount = 0;
const firedTally: Record<string, number> = {};

for (const id of normalIds) {
  const cart = (cartByCustomer.get(id) ?? []).find((c) => c.status !== "paid");
  const sub = (subByCustomer.get(id) ?? []).find((x) => x.status === "failed" || x.status === "halted");
  const facts: TriggeringEventFacts | null = cart
    ? {
        agent: "cart_abandonment",
        timestamp: cart.created_at,
        amount: cart.amount,
        paymentAttempted: cart.attempts > 0,
        paymentErrorCode: cart.last_error_code,
      }
    : sub
      ? {
          agent: "subscription_recovery",
          timestamp: sub.created_at,
          amount: sub.plan_amount,
          paymentAttempted: true,
          paymentErrorCode: sub.error_code,
        }
      : null;
  if (!facts) continue;
  evaluated += 1;

  const profile = computeMemoryProfile(db, id, "memory", facts.timestamp);
  const signals = computeMemorySignals(profile, facts) as unknown as Record<string, unknown>;
  if (signals.paymentFriction === true) paymentFrictionCount += 1;

  const offending = Object.entries(MEMORY_DERIVED_DEFAULTS).filter(([k, def]) => signals[k] !== def);
  if (offending.length > 0) {
    for (const [k, def] of offending) {
      firedTally[k] = (firedTally[k] ?? 0) + 1;
      void def;
    }
    noisy.push(id);
  }
}
db.close();

const silentRate = evaluated === 0 ? 0 : ((evaluated - noisy.length) / evaluated) * 100;
console.log(
  `        ${evaluated} of ${normalIds.length} normal customers evaluated at their triggering event; ` +
    `${evaluated - noisy.length} silent (${silentRate.toFixed(1)}%)`,
);
console.log(
  `        paymentFriction (router, reads the event not memory, no effects): ` +
    `${paymentFrictionCount}/${evaluated} — expected, not a failure`,
);
if (Object.keys(firedTally).length > 0) {
  console.log(`        memory-derived signals that fired: ${JSON.stringify(firedTally)}`);
}
assert(
  "no memory-derived signal fires anywhere in the control cohort",
  noisy,
  `${Object.keys(MEMORY_DERIVED_DEFAULTS).length} signals checked against their defaults`,
);

const weightSum = Object.values(SCENARIO_WEIGHTS).reduce((a, b) => a + b, 0);
assert(
  "scenario weights sum to 1.0",
  Math.abs(weightSum - 1) < 1e-9 ? [] : [`sum = ${weightSum}`],
);

console.log("");
if (failures > 0) {
  console.error(`${failures} assertion(s) FAILED.\n`);
  process.exit(1);
}
console.log("All assertions passed.\n");
