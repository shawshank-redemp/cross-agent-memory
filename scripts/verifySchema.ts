// Scratch verification of the schema-cleanup invariants. Reads the loaded DB
// and the generated batch; makes no API calls and writes nothing.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/db/connection.js";
import { computeMemoryProfile } from "../src/memory/profile.js";
import { computeMemorySignals, type TriggeringEventFacts } from "../src/agents/policy.js";
import { disputeFaultForReason } from "../src/data/fixtures.js";
import type { DisputeEvent } from "../src/types/index.js";
import type { ScenarioLabel } from "../src/data/generator.js";
import { runDisputeMappingFixture } from "./pinDisputeMapping.js";

const GENERATED_DIR = join(import.meta.dirname, "..", "data", "generated");
const readJson = <T>(f: string): T => JSON.parse(readFileSync(join(GENERATED_DIR, f), "utf-8")) as T;

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// --- 0. dispute-status mapping, pinned against an in-memory fixture --------
// Runs first and independently of the generated batch: if the won/lost arms
// are ever flipped back, this fails before anything else is even read.
console.log("  -- dispute-status mapping fixture --");
runDisputeMappingFixture(check);
console.log("  -- batch invariants --");

const db = openDb();

// --- 1. resolved_at invariants -------------------------------------------
const unresolvedWithDate = db
  .prepare(
    `SELECT COUNT(*) AS n FROM dispute_events
     WHERE status IN ('open','under_review') AND resolved_at IS NOT NULL`,
  )
  .get() as { n: number };
check("no open/under_review dispute carries a resolved_at", unresolvedWithDate.n === 0, `${unresolvedWithDate.n} rows`);

const terminalMissing = db
  .prepare(
    `SELECT COUNT(*) AS n FROM dispute_events
     WHERE status IN ('won','lost','closed') AND resolved_at IS NULL`,
  )
  .get() as { n: number };
check("every won/lost/closed dispute has a resolved_at", terminalMissing.n === 0, `${terminalMissing.n} rows`);

const notStrictlyAfter = db
  .prepare(
    `SELECT COUNT(*) AS n FROM dispute_events
     WHERE resolved_at IS NOT NULL AND resolved_at <= dispute_created_at`,
  )
  .get() as { n: number };
check("resolved_at is strictly after dispute_created_at", notStrictlyAfter.n === 0, `${notStrictlyAfter.n} rows`);

// --- 2. cross_domain_risk: planted dispute resolves before the later cart --
const labels = readJson<ScenarioLabel[]>("scenario_labels.json");
const crossDomainLabels = labels.filter((l) => l.scenario === "cross_domain_risk");
const crossDomain = new Set(crossDomainLabels.map((l) => l.customer_id));

interface LaterCart {
  created_at: string;
  amount: number;
  attempts: number;
  last_error_code: string | null;
}
const laterCartByCustomer = new Map<string, LaterCart>();
for (const row of db
  .prepare(
    "SELECT customer_id, created_at, amount, attempts, last_error_code FROM cart_abandonment_events WHERE status != 'paid'",
  )
  .all() as ({ customer_id: string } & LaterCart)[]) {
  if (crossDomain.has(row.customer_id)) {
    laterCartByCustomer.set(row.customer_id, {
      created_at: row.created_at,
      amount: row.amount,
      attempts: row.attempts,
      last_error_code: row.last_error_code,
    });
  }
}

const crossDomainDisputes = (db.prepare("SELECT * FROM dispute_events").all() as DisputeEvent[]).filter((d) =>
  crossDomain.has(d.customer_id),
);
const outcomeCounts: Record<string, number> = {};
for (const l of crossDomainLabels) outcomeCounts[l.dispute_outcome ?? "none"] = (outcomeCounts[l.dispute_outcome ?? "none"] ?? 0) + 1;
console.log(`\n  cross_domain_risk dispute outcomes: ${JSON.stringify(outcomeCounts)}\n`);

check(
  "every cross_domain_risk customer carries a dispute_outcome label",
  crossDomainLabels.every((l) => l.dispute_outcome != null),
  `${crossDomainLabels.filter((l) => l.dispute_outcome == null).length} missing`,
);

// A terminal dispute (won or lost) must be RESOLVED before the later cart, or
// the cart agent reads it as merely unresolved and all three variants collapse
// into the same signal. under_review is unresolved by design.
const terminal = crossDomainDisputes.filter((d) => d.status === "lost" || d.status === "won");
const lateResolutions = terminal.filter((d) => {
  const cart = laterCartByCustomer.get(d.customer_id);
  return !cart || d.resolved_at == null || d.resolved_at >= cart.created_at;
});
check(
  `every cross_domain_risk terminal dispute resolves before that customer's later cart (${terminal.length} checked)`,
  terminal.length > 0 && lateResolutions.length === 0,
  `${lateResolutions.length} resolve too late`,
);

// The no-suppression-expected arm is Razorpay 'lost' (the merchant conceded).
const CONCEDED_COHORT_FLOOR = 15;
check(
  `merchant-conceded cohort (rzp 'lost') is large enough to be non-anecdotal (>= ${CONCEDED_COHORT_FLOOR})`,
  (outcomeCounts.lost ?? 0) >= CONCEDED_COHORT_FLOOR,
  `${outcomeCounts.lost ?? 0} customers`,
);

// The paired claim itself: identical event shape, opposite caution level,
// because the dispute outcome differed.
const levelAtLaterCart = (customerId: string): string | null => {
  const cart = laterCartByCustomer.get(customerId);
  if (!cart) return null;
  const facts: TriggeringEventFacts = {
    agent: "cart_abandonment",
    timestamp: cart.created_at,
    amount: cart.amount,
    paymentAttempted: cart.attempts >= 1,
    paymentErrorCode: cart.last_error_code,
  };
  return computeMemorySignals(computeMemoryProfile(db, customerId, "memory", cart.created_at), facts)
    .disputeCautionLevel;
};

// Razorpay status -> expected caution level. 'won' means the MERCHANT won
// (customer-adverse); 'lost' means the merchant conceded (no caution). An
// unresolved dispute's level depends on its REASON, so that arm is derived
// from the planted reason rather than hardcoded.
const reasonByCustomer = new Map(
  (db.prepare("SELECT customer_id, dispute_reason FROM dispute_events").all() as {
    customer_id: string;
    dispute_reason: string;
  }[]).map((r) => [r.customer_id, r.dispute_reason]),
);
const expectedLevelFor = (customerId: string, outcome: string): string => {
  if (outcome === "won") return "adverse";
  if (outcome === "lost") return "none";
  const fault = disputeFaultForReason(reasonByCustomer.get(customerId) ?? "");
  return `unresolved_${fault}_fault`.replace("_neutral_fault", "_neutral");
};
const levelMismatches = crossDomainLabels
  .map((l) => ({
    id: l.customer_id,
    outcome: l.dispute_outcome ?? "none",
    expected: expectedLevelFor(l.customer_id, l.dispute_outcome ?? "none"),
    level: levelAtLaterCart(l.customer_id),
  }))
  .filter((r) => r.level != null && r.level !== r.expected);
check(
  "disputeCautionLevel at the later cart matches the planted outcome (rzp won->adverse, rzp lost->none, under_review->reason-derived tier)",
  levelMismatches.length === 0,
  `${levelMismatches.length} mismatches, e.g. ${JSON.stringify(levelMismatches[0] ?? {})}`,
);

// --- 3. attempts / last_* coherence ---------------------------------------
const zeroAttemptsDirty = db
  .prepare(
    `SELECT COUNT(*) AS n FROM cart_abandonment_events
     WHERE attempts = 0 AND (last_method IS NOT NULL OR last_error_code IS NOT NULL OR last_error_description IS NOT NULL)`,
  )
  .get() as { n: number };
check("attempts = 0 rows have null last_* fields", zeroAttemptsDirty.n === 0, `${zeroAttemptsDirty.n} rows`);

const attemptedMissing = db
  .prepare(
    `SELECT COUNT(*) AS n FROM cart_abandonment_events
     WHERE status = 'attempted' AND (attempts < 1 OR last_method IS NULL OR last_error_code IS NULL)`,
  )
  .get() as { n: number };
check("status='attempted' rows have attempts >= 1 and a populated failure", attemptedMissing.n === 0, `${attemptedMissing.n} rows`);

const paidDirty = db
  .prepare(
    `SELECT COUNT(*) AS n FROM cart_abandonment_events
     WHERE status = 'paid' AND (attempts < 1 OR last_method IS NULL OR last_error_code IS NOT NULL)`,
  )
  .get() as { n: number };
check("status='paid' rows have a method and no error (the last attempt succeeded)", paidDirty.n === 0, `${paidDirty.n} rows`);

const amountMismatch = db
  .prepare("SELECT COUNT(*) AS n FROM cart_abandonment_events WHERE amount_due != amount - amount_paid")
  .get() as { n: number };
check("amount_due = amount - amount_paid on every order", amountMismatch.n === 0, `${amountMismatch.n} rows`);

// --- 4. dispute caution level flips across a won dispute's resolution ------
// Needs a customer whose ONLY dispute is a resolved merchant-conceded one, so
// the caution level flips cleanly across its resolution with no second dispute
// holding the level up. Selected by that property directly rather than by
// scenario: this used to look inside `normal`, which was coupled to
// generateNormal happening to emit 'lost' disputes. When that scenario changed
// to emit recovery-ELIGIBLE events (an open dispute has something left to
// file; a ruled one does not), the fixture vanished and the check failed for a
// reason that had nothing to do with the property under test.
const disputesPerCustomer = new Map<string, number>();
for (const row of db.prepare("SELECT customer_id FROM dispute_events").all() as { customer_id: string }[]) {
  disputesPerCustomer.set(row.customer_id, (disputesPerCustomer.get(row.customer_id) ?? 0) + 1);
}
// Razorpay 'lost' = the merchant conceded, i.e. the no-caution outcome.
const concededDispute = (db.prepare("SELECT * FROM dispute_events WHERE status = 'lost'").all() as DisputeEvent[]).find(
  (d) => d.resolved_at != null && disputesPerCustomer.get(d.customer_id) === 1,
);

if (!concededDispute) {
  check("found a customer whose only dispute is a resolved merchant-conceded (rzp 'lost') one", false);
} else {
  const midpoint = new Date(
    (Date.parse(concededDispute.dispute_created_at) + Date.parse(concededDispute.resolved_at!)) / 2,
  ).toISOString();
  const after = new Date(Date.parse(concededDispute.resolved_at!) + 1000).toISOString();

  const midProfile = computeMemoryProfile(db, concededDispute.customer_id, "memory", midpoint);
  const afterProfile = computeMemoryProfile(db, concededDispute.customer_id, "memory", after);
  const factsAt = (ts: string): TriggeringEventFacts => ({
    agent: "cart_abandonment",
    timestamp: ts,
    amount: 0,
    paymentAttempted: false,
    paymentErrorCode: null,
  });
  const midLevel = computeMemorySignals(midProfile, factsAt(midpoint)).disputeCautionLevel;
  const afterLevel = computeMemorySignals(afterProfile, factsAt(after)).disputeCautionLevel;

  console.log(`\n  merchant-conceded dispute ${concededDispute.dispute_id} (customer ${concededDispute.customer_id})`);
  console.log(`    filed ${concededDispute.dispute_created_at} -> resolved ${concededDispute.resolved_at}`);
  console.log(`    asOf midpoint  ${midpoint}: level=${midLevel}, breakdown=${JSON.stringify(midProfile.dispute_breakdown)}`);
  console.log(`    asOf after     ${after}: level=${afterLevel}, breakdown=${JSON.stringify(afterProfile.dispute_breakdown)}\n`);

  check(
    "asOf BETWEEN filed and resolved -> an unresolved_* caution level",
    midLevel.startsWith("unresolved_"),
    `got ${midLevel}`,
  );
  check('asOf AFTER resolved_at -> disputeCautionLevel "none"', afterLevel === "none", `got ${afterLevel}`);
  check("a conceded dispute still counts in dispute_count", afterProfile.dispute_count >= 1);
  check("a conceded dispute contributes 0 to adverse_disputed_amount", afterProfile.adverse_disputed_amount === 0);
  // The "health score is not penalised once the merchant concedes" check went
  // with the field it tested. What it was really asserting — that a conceded
  // dispute carries no penalty — is still covered by the two checks above, on
  // the breakdown and on adverse_disputed_amount, which is where the property
  // actually lives.
}

// --- 5. breakdown partitions dispute_count --------------------------------
const sampleIds = (db.prepare("SELECT DISTINCT customer_id FROM dispute_events LIMIT 200").all() as {
  customer_id: string;
}[]).map((r) => r.customer_id);
const partitionBreaks = sampleIds.filter((id) => {
  const p = computeMemoryProfile(db, id, "memory");
  const b = p.dispute_breakdown;
  return b.unresolved + b.merchant_conceded + b.customer_adverse + b.closed_undetermined !== p.dispute_count;
});
check(
  `dispute_breakdown sums to dispute_count (${sampleIds.length} customers)`,
  partitionBreaks.length === 0,
  `${partitionBreaks.length} mismatches`,
);

db.close();
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
