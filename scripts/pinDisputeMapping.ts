// Pins the Razorpay dispute-status -> memory-profile mapping against a
// hand-built in-memory fixture, independent of the generated batch.
//
// This exists because the mapping shipped INVERTED once. A Razorpay dispute
// belongs to the MERCHANT, so its status describes how it went for the
// merchant, not the customer:
//
//   'won'  -> the merchant's evidence was accepted; the complaint was
//             rejected. CUSTOMER-ADVERSE.
//   'lost' -> the merchant lost or accepted the chargeback and the customer
//             was refunded. Evidence about the MERCHANT; no caution.
//
// Reading `status = 'won'` as "the customer won" is the intuitive reading and
// the wrong one. If a future edit flips these arms back, this fails loudly
// instead of quietly mispenalising every customer who was refunded.
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeMemoryProfile } from "../src/memory/profile.js";
import { computeMemorySignals, type TriggeringEventFacts } from "../src/agents/policy.js";
import type { DisputeStatus } from "../src/types/index.js";

const SCHEMA_PATH = join(import.meta.dirname, "..", "src", "db", "schema.sql");

const CUSTOMER = "cust_fixture";
const FILED_AT = "2026-01-01T00:00:00.000Z";
const RESOLVED_AT = "2026-02-01T00:00:00.000Z";
const BEFORE_RESOLUTION = "2026-01-15T00:00:00.000Z";
const AFTER_RESOLUTION = "2026-03-01T00:00:00.000Z";
const AMOUNT = 50_000;

function buildDb(status: DisputeStatus, reason = "goods_not_received"): Database.Database {
  const db = new Database(":memory:");
  db.exec(readFileSync(SCHEMA_PATH, "utf-8"));
  db.prepare(
    `INSERT INTO customers (customer_id, name, email, contact, signup_date, plan_tier)
     VALUES (?, 'Fixture', 'f@example.com', '+910000000000', '2025-01-01T00:00:00.000Z', 'basic')`,
  ).run(CUSTOMER);
  const resolvedAt = status === "open" || status === "under_review" ? null : RESOLVED_AT;
  db.prepare(
    `INSERT INTO dispute_events
       (dispute_id, customer_id, payment_id, order_id, amount, dispute_reason,
        dispute_created_at, resolved_at, status)
     VALUES ('dispute_fixture', ?, 'pay_fixture', 'order_fixture', ?, ?, ?, ?, ?)`,
  ).run(CUSTOMER, AMOUNT, reason, FILED_AT, resolvedAt, status);
  return db;
}

interface Expectation {
  status: DisputeStatus;
  asOf: string;
  label: string;
  // Defaults to a merchant-fault reason; set explicitly where the assertion
  // is about the reason-derived tier rather than the status mapping.
  reason?: string;
  bucket: "unresolved" | "merchant_conceded" | "customer_adverse" | "closed_undetermined";
  cautionLevel: string;
  adverseAmount: number;
}

// One row per (status, as-of) combination that the mapping must satisfy.
const EXPECTATIONS: Expectation[] = [
  {
    status: "won",
    asOf: AFTER_RESOLUTION,
    label: "rzp 'won' after resolution = merchant contested successfully",
    bucket: "customer_adverse",
    cautionLevel: "adverse",
    adverseAmount: AMOUNT,
  },
  {
    status: "lost",
    asOf: AFTER_RESOLUTION,
    label: "rzp 'lost' after resolution = merchant conceded, customer refunded",
    bucket: "merchant_conceded",
    cautionLevel: "none",
    adverseAmount: 0,
  },
  {
    status: "closed",
    asOf: AFTER_RESOLUTION,
    label: "rzp 'closed' after resolution = no ruling either way",
    bucket: "closed_undetermined",
    cautionLevel: "none",
    adverseAmount: 0,
  },
  {
    status: "under_review",
    asOf: AFTER_RESOLUTION,
    label: "rzp 'under_review' never resolves",
    bucket: "unresolved",
    cautionLevel: "unresolved_merchant_fault",
    adverseAmount: 0,
  },
  // The as-of guard: a terminal status must NOT leak backwards before its
  // resolved_at. Both of these read as `unresolved` mid-flight.
  {
    status: "won",
    asOf: BEFORE_RESOLUTION,
    label: "rzp 'won' BEFORE its resolved_at must not leak backwards",
    bucket: "unresolved",
    cautionLevel: "unresolved_merchant_fault",
    adverseAmount: 0,
  },
  {
    status: "lost",
    asOf: BEFORE_RESOLUTION,
    label: "rzp 'lost' BEFORE its resolved_at must not leak backwards",
    bucket: "unresolved",
    cautionLevel: "unresolved_merchant_fault",
    adverseAmount: 0,
  },
  // The unresolved tier is split by REASON, since at decision time the reason
  // is usually the only evidence available. An unknown reason must fall back
  // to "neutral" and never manufacture suspicion.
  {
    status: "under_review",
    asOf: AFTER_RESOLUTION,
    reason: "service_not_as_described",
    label: "unresolved + merchant-fault reason",
    bucket: "unresolved",
    cautionLevel: "unresolved_merchant_fault",
    adverseAmount: 0,
  },
  {
    status: "under_review",
    asOf: AFTER_RESOLUTION,
    reason: "duplicate_charge",
    label: "unresolved + neutral reason",
    bucket: "unresolved",
    cautionLevel: "unresolved_neutral",
    adverseAmount: 0,
  },
  {
    status: "under_review",
    asOf: AFTER_RESOLUTION,
    reason: "unrecognized_transaction",
    label: "unresolved + customer-fault reason",
    bucket: "unresolved",
    cautionLevel: "unresolved_customer_fault",
    adverseAmount: 0,
  },
  {
    status: "under_review",
    asOf: AFTER_RESOLUTION,
    reason: "some_reason_nobody_has_mapped_yet",
    label: "unresolved + UNKNOWN reason falls back to neutral, never to customer fault",
    bucket: "unresolved",
    cautionLevel: "unresolved_neutral",
    adverseAmount: 0,
  },
];

export function runDisputeMappingFixture(check: (name: string, ok: boolean, detail?: string) => void): void {
  for (const e of EXPECTATIONS) {
    const db = buildDb(e.status, e.reason);
    const profile = computeMemoryProfile(db, CUSTOMER, "memory", e.asOf);
    // The dispute-caution signal reads only the memory profile, never the
    // triggering event — the descriptor below just satisfies the signature.
    const facts: TriggeringEventFacts = {
      agent: "dispute_responder",
      timestamp: e.asOf,
      amount: AMOUNT,
      paymentAttempted: false,
      paymentErrorCode: null,
    };
    const level = computeMemorySignals(profile, facts).disputeCautionLevel;
    db.close();

    const breakdown = profile.dispute_breakdown;
    const bucketOk =
      breakdown[e.bucket] === 1 &&
      Object.entries(breakdown)
        .filter(([k]) => k !== e.bucket)
        .every(([, v]) => v === 0);

    check(`${e.label} -> breakdown.${e.bucket}`, bucketOk, JSON.stringify(breakdown));
    check(`${e.label} -> cautionLevel "${e.cautionLevel}"`, level === e.cautionLevel, `got "${level}"`);
    check(
      `${e.label} -> adverse_disputed_amount ${e.adverseAmount}`,
      profile.adverse_disputed_amount === e.adverseAmount,
      `got ${profile.adverse_disputed_amount}`,
    );
  }
}
