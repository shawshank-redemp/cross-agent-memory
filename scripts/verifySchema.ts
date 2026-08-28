// Scratch verification of the schema-cleanup invariants. Reads the loaded DB
// and the generated batch; makes no API calls and writes nothing.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/db/connection.js";
import { computeMemoryProfile } from "../src/memory/profile.js";
import { computeMemorySignals } from "../src/agents/policy.js";
import type { DisputeEvent } from "../src/types/index.js";
import type { ScenarioLabel } from "../src/data/generator.js";

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

const laterCartByCustomer = new Map<string, string>();
for (const row of db
  .prepare("SELECT customer_id, created_at FROM cart_abandonment_events WHERE status != 'paid'")
  .all() as { customer_id: string; created_at: string }[]) {
  if (crossDomain.has(row.customer_id)) laterCartByCustomer.set(row.customer_id, row.created_at);
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
  const cartAt = laterCartByCustomer.get(d.customer_id);
  return !cartAt || d.resolved_at == null || d.resolved_at >= cartAt;
});
check(
  `every cross_domain_risk terminal dispute resolves before that customer's later cart (${terminal.length} checked)`,
  terminal.length > 0 && lateResolutions.length === 0,
  `${lateResolutions.length} resolve too late`,
);

const WON_COHORT_FLOOR = 15;
check(
  `won cohort is large enough to be non-anecdotal (>= ${WON_COHORT_FLOOR})`,
  (outcomeCounts.won ?? 0) >= WON_COHORT_FLOOR,
  `${outcomeCounts.won ?? 0} customers`,
);

// The paired claim itself: identical event shape, opposite caution level,
// because the dispute outcome differed.
const levelAtLaterCart = (customerId: string): string | null => {
  const cartAt = laterCartByCustomer.get(customerId);
  if (!cartAt) return null;
  return computeMemorySignals(computeMemoryProfile(db, customerId, "memory", cartAt), "cart_abandonment")
    .disputeCautionLevel;
};

const expectedLevel: Record<string, string> = { won: "none", lost: "adverse", under_review: "unresolved" };
const levelMismatches = crossDomainLabels
  .map((l) => ({ id: l.customer_id, outcome: l.dispute_outcome ?? "none", level: levelAtLaterCart(l.customer_id) }))
  .filter((r) => r.level != null && r.level !== expectedLevel[r.outcome]);
check(
  "disputeCautionLevel at the later cart matches the planted outcome (won->none, lost->adverse, under_review->unresolved)",
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
const normalCustomers = new Set(labels.filter((l) => l.scenario === "normal").map((l) => l.customer_id));
const wonDispute = (db.prepare("SELECT * FROM dispute_events WHERE status = 'won'").all() as DisputeEvent[]).find(
  (d) => normalCustomers.has(d.customer_id) && d.resolved_at != null,
);

if (!wonDispute) {
  check("found a `normal` customer with a won dispute", false);
} else {
  const midpoint = new Date(
    (Date.parse(wonDispute.dispute_created_at) + Date.parse(wonDispute.resolved_at!)) / 2,
  ).toISOString();
  const after = new Date(Date.parse(wonDispute.resolved_at!) + 1000).toISOString();

  const midProfile = computeMemoryProfile(db, wonDispute.customer_id, "memory", midpoint);
  const afterProfile = computeMemoryProfile(db, wonDispute.customer_id, "memory", after);
  const midLevel = computeMemorySignals(midProfile, "cart_abandonment").disputeCautionLevel;
  const afterLevel = computeMemorySignals(afterProfile, "cart_abandonment").disputeCautionLevel;

  console.log(`\n  won dispute ${wonDispute.dispute_id} (customer ${wonDispute.customer_id})`);
  console.log(`    filed ${wonDispute.dispute_created_at} -> resolved ${wonDispute.resolved_at}`);
  console.log(`    asOf midpoint  ${midpoint}: level=${midLevel}, breakdown=${JSON.stringify(midProfile.dispute_breakdown)}`);
  console.log(`    asOf after     ${after}: level=${afterLevel}, breakdown=${JSON.stringify(afterProfile.dispute_breakdown)}\n`);

  check('asOf BETWEEN filed and resolved -> disputeCautionLevel "unresolved"', midLevel === "unresolved", `got ${midLevel}`);
  check('asOf AFTER resolved_at -> disputeCautionLevel "none"', afterLevel === "none", `got ${afterLevel}`);
  check("a won dispute still counts in dispute_count", afterProfile.dispute_count >= 1);
  check("a won dispute contributes 0 to adverse_disputed_amount", afterProfile.adverse_disputed_amount === 0);
  check(
    "health score is not penalised once the dispute is won",
    afterProfile.rolling_health_score >= midProfile.rolling_health_score,
    `${midProfile.rolling_health_score} -> ${afterProfile.rolling_health_score}`,
  );
}

// --- 5. breakdown partitions dispute_count --------------------------------
const sampleIds = (db.prepare("SELECT DISTINCT customer_id FROM dispute_events LIMIT 200").all() as {
  customer_id: string;
}[]).map((r) => r.customer_id);
const partitionBreaks = sampleIds.filter((id) => {
  const p = computeMemoryProfile(db, id, "memory");
  const b = p.dispute_breakdown;
  return b.unresolved + b.won + b.adverse + b.closed_undetermined !== p.dispute_count;
});
check(
  `dispute_breakdown sums to dispute_count (${sampleIds.length} customers)`,
  partitionBreaks.length === 0,
  `${partitionBreaks.length} mismatches`,
);

db.close();
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
