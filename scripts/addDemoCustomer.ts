// THE DEMO FIXTURE — one hand-shaped customer, appended to the generated batch.
//
// Everything else in data/generated/ comes from the seeded generator. This one
// customer is composed by hand so the Live Decision Trace replay has a decision
// where the memory arm's behaviour is DETERMINISTIC rather than hoped for: a
// dispute ruled against the customer makes disputeCautionLevel "adverse", which
// BLOCKS spend outright, so whatever the model proposes in the memory arm is
// nulled by enforcement while the baseline's ceiling stays at 20%.
//
// WHAT THIS IS AND IS NOT. Composing input data is what the generator already
// does — every scenario in this batch is a deliberately planted pattern, and
// this is one more, built to the same rules. What is NOT fabricated is the
// OUTPUT: the model is called for real on these events and the replay page
// renders only what the run actually recorded. That distinction is the rule the
// replay page rests on, and it holds here.
//
// Labelled `cross_domain_risk` because that is honestly the pattern — a dispute
// followed by a later abandonment. It is a richer instance than the generator's
// template (which plants one cart), not a different scenario. Adding one
// customer moves that cohort's share by 0.12pp, well inside validate:data's 2pp
// tolerance.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeId } from "../src/lib/ids.js";
import { createRng } from "../src/lib/rng.js";

// Seeded, so re-running this script produces the SAME ids rather than a second
// copy of the customer under new ones.
const rng = createRng(20260904);
const newId = (prefix: string) => makeId(prefix, rng);

const DIR = join(import.meta.dirname, "..", "data", "generated");
const read = <T>(f: string): T[] => JSON.parse(readFileSync(join(DIR, `${f}.json`), "utf-8")) as T[];
const write = (f: string, v: unknown) => writeFileSync(join(DIR, `${f}.json`), JSON.stringify(v, null, 2));

const customerId = newId("cust");
const paidOrderId = newId("order");
const paidPaymentId = newId("pay");
const subscriptionId = newId("sub");
const planId = newId("plan");

// TIMELINE. Every gap is wider than CHURN_LOOKBACK_DAYS (14), so
// recentMultiDomainTrouble never fires and this customer is never escalated —
// the story stays "memory refused to spend, and no person was needed", which is
// the block/escalate split working.
const T = {
  paidOrder: "2026-05-04T10:15:22.000Z",
  disputeFiled: "2026-05-14T09:30:41.000Z",
  disputeRuled: "2026-06-20T15:02:10.000Z", // AFTER the first abandonment, on purpose
  cartA: "2026-06-05T14:20:07.000Z",
  subA: "2026-06-24T11:05:33.000Z",
  subB: "2026-07-13T16:40:19.000Z",
  cartB: "2026-08-01T13:25:48.000Z", // THE decision the replay shows
};

const customers = read<Record<string, unknown>>("customers");
customers.push({
  customer_id: customerId,
  name: "Meera Iyer",
  email: "meera.iyer471@outlook.com",
  contact: "+919845120773",
  // Strictly outside the event window, like every other customer.
  signup_date: "2025-08-15T00:00:00.000Z",
  plan_tier: "premium",
});

const carts = read<Record<string, unknown>>("cart_abandonment_events");
carts.push(
  // A real customer first: they paid. Not a recovery event, but it is what makes
  // the dispute possible and gives provenPayer something to weigh.
  {
    order_id: paidOrderId, customer_id: customerId,
    amount: 120_000, amount_paid: 120_000, amount_due: 0, currency: "INR",
    status: "paid", attempts: 1, last_method: "card",
    last_error_code: null, last_error_description: null,
    notes: { items: 2, channel: "web" }, created_at: T.paidOrder,
  },
  // First abandonment. The dispute is filed but NOT yet ruled on, so memory
  // tightens the ceiling to 10% here rather than blocking — the same customer,
  // a different answer, purely because of what was known at the time.
  {
    order_id: newId("order"), customer_id: customerId,
    amount: 90_000, amount_paid: 0, amount_due: 90_000, currency: "INR",
    status: "created", attempts: 0, last_method: null,
    last_error_code: null, last_error_description: null,
    notes: { items: 3, channel: "app" }, created_at: T.cartA,
  },
  // THE DECISION. Zero payment attempts, so there is no declined-card argument
  // for the model to refuse on — the only question is whether to spend. ₹5,000
  // is the batch maximum, so the baseline's 20% ceiling is a visible ₹1,000.
  {
    order_id: newId("order"), customer_id: customerId,
    amount: 500_000, amount_paid: 0, amount_due: 500_000, currency: "INR",
    status: "created", attempts: 0, last_method: null,
    last_error_code: null, last_error_description: null,
    notes: { items: 5, channel: "web" }, created_at: T.cartB,
  },
);
write("cart_abandonment_events", carts);

// Two failed cycles on ONE subscription. paid_count stays 1: combined with the
// paid order that puts successful_payment_count at 2 — which MEETS
// MIN_SUCCESSFUL_PAYMENTS while lifetime spend (₹1,699) falls short of
// MIN_LIFETIME_PAID_PAISE. provenPayer therefore reads false, and the signals
// block says why. That is the value-aware accelerator earning its keep on the
// demo screen: under the old count-only rule this customer would have been
// handed a WIDER ceiling.
const subs = read<Record<string, unknown>>("subscription_failure_events");
for (const created_at of [T.subA, T.subB]) {
  subs.push({
    payment_id: newId("pay"), subscription_id: subscriptionId, customer_id: customerId,
    plan_id: planId, plan_amount: 49_900, plan_period: "monthly", plan_interval: 1,
    paid_count: 1, total_count: 12, status: "failed", method: "upi",
    error_code: "GATEWAY_ERROR",
    error_description: "Your payment was declined by the bank. Please try another payment method.",
    created_at,
  });
}
write("subscription_failure_events", subs);

// The dispute. "unrecognized_transaction" points at the CUSTOMER, and the bank
// then ruled for the merchant — so the unresolved tier and the final ruling
// agree, which keeps the demo's story simple. Razorpay 'won' means the MERCHANT
// won; this is the customer-adverse outcome.
//
// resolved_at falls between the two abandonments deliberately: the same dispute
// reads as unresolved at the first cart and adverse at the second, which is the
// as-of correctness this system is built on, visible on one customer.
const disputes = read<Record<string, unknown>>("dispute_events");
disputes.push({
  dispute_id: newId("dispute"), customer_id: customerId,
  payment_id: paidPaymentId, order_id: paidOrderId,
  amount: 120_000, // a chargeback cannot exceed what was charged
  dispute_reason: "unrecognized_transaction",
  dispute_created_at: T.disputeFiled, resolved_at: T.disputeRuled, status: "won",
});
write("dispute_events", disputes);

const labels = read<Record<string, unknown>>("scenario_labels");
labels.push({
  customer_id: customerId, scenario: "cross_domain_risk", dispute_outcome: "won",
  note: "DEMO FIXTURE, hand-composed for the Live Decision Trace replay — not generator output. A dispute ruled against the customer makes the final cart decision a deterministic block in the memory arm.",
});
write("scenario_labels", labels);
write("customers", customers);

console.log(`Demo customer: ${customerId}  "Meera Iyer"`);
console.log(`  decision event (last cart): the ₹5,000 order at ${T.cartB}`);
console.log(`  run it with:  npm run agents:memory -- --customer=${customerId}`);
