// What a full two-arm evaluation run will cost, against the CURRENT database.
//
// Reads only — no API calls, no writes. Run it before paying for a batch.
//
// The per-call token figures below are ESTIMATES, not measurements. They are
// the largest source of error in the projection: the event counts are exact,
// the price constants are published, and the token figures are a guess.
// Override them with --input-tokens / --output-tokens once real per-call
// numbers are in hand (a run's usage is on each API response).

import Database from "better-sqlite3";
import { openDb } from "../src/db/connection.js";
import { BATCH_DISCOUNT, DEFAULT_PRICING_MODEL, pricingFor } from "../src/lib/pricing.js";
import {
  CART_ELIGIBLE_SQL,
  DISPUTE_ELIGIBLE_SQL,
  SUBSCRIPTION_ELIGIBLE_SQL,
} from "../src/db/eligibility.js";

// ---------------------------------------------------------------------------
// Pricing. Claude Opus 5, USD per MILLION tokens.
// ---------------------------------------------------------------------------
// Imported, not restated: the runner prints ACTUAL cost from the same table
// after a run, and a projection that disagreed with the actual would be worse
// than no projection.
const PRICING = pricingFor(DEFAULT_PRICING_MODEL)!;
const USD_PER_MTOK_INPUT = PRICING.inputPerMTok;
const USD_PER_MTOK_OUTPUT = PRICING.outputPerMTok;

// The Batch API is half price. The runner does not use it and cannot trivially:
// decisions within a customer are sequential, since discount_usage_history
// written by one decision feeds stoppingRuleHit on the next, while the Batch
// API needs every request submitted up front. The batch column is therefore an
// upper bound on what a restructured run could save, not a switch to flip.

// Rough per-call token estimates. Input is the system prompt, the objective
// block, the memory payload and the signal prose; output is 3-5 sentences of
// reasoning plus the structured decision fields.
//
// Calibrated against the one observation available: a ~4,240-event batch, two
// arms, was estimated at ~$120 at standard pricing, which implies ~$0.0141 per
// call. These defaults reproduce that. They are not measured per-call figures
// and should be replaced with real ones.
const DEFAULT_INPUT_TOKENS = 1500;
const DEFAULT_OUTPUT_TOKENS = 300;

const ARMS = 2; // baseline + memory

function flag(argv: string[], name: string, fallback: number): number {
  const found = argv.find((a) => a.startsWith(`--${name}=`));
  if (!found) return fallback;
  const raw = found.slice(name.length + 3);
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`--${name} must be a non-negative number, got "${raw}"`);
    process.exit(1);
  }
  return n;
}

const argv = process.argv.slice(2);
const inputTokens = flag(argv, "input-tokens", DEFAULT_INPUT_TOKENS);
const outputTokens = flag(argv, "output-tokens", DEFAULT_OUTPUT_TOKENS);
const usingDefaults = inputTokens === DEFAULT_INPUT_TOKENS && outputTokens === DEFAULT_OUTPUT_TOKENS;

const db: Database.Database = openDb();

const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;

const totals = {
  cart: count("SELECT COUNT(*) AS n FROM cart_abandonment_events"),
  subscription: count("SELECT COUNT(*) AS n FROM subscription_failure_events"),
  dispute: count("SELECT COUNT(*) AS n FROM dispute_events"),
};
const eligible = {
  cart: count(`SELECT COUNT(*) AS n FROM cart_abandonment_events WHERE ${CART_ELIGIBLE_SQL}`),
  subscription: count(`SELECT COUNT(*) AS n FROM subscription_failure_events WHERE ${SUBSCRIPTION_ELIGIBLE_SQL}`),
  dispute: count(`SELECT COUNT(*) AS n FROM dispute_events WHERE ${DISPUTE_ELIGIBLE_SQL}`),
};

const totalEvents = totals.cart + totals.subscription + totals.dispute;
const totalEligible = eligible.cart + eligible.subscription + eligible.dispute;
const customers = count("SELECT COUNT(*) AS n FROM customers");

// scenario_labels is ground truth about how the batch was built; it is not in
// the DB, so the per-scenario split is read from the generated file.
interface ScenarioRow {
  scenario: string;
  total: number;
  eligible: number;
}
const perScenario = new Map<string, ScenarioRow>();
try {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "generated");
  const labels = JSON.parse(readFileSync(join(dir, "scenario_labels.json"), "utf-8")) as {
    customer_id: string;
    scenario: string;
  }[];
  const scenarioOf = new Map(labels.map((l) => [l.customer_id, l.scenario]));
  const bump = (cid: string, isEligible: boolean): void => {
    const scenario = scenarioOf.get(cid) ?? "(unlabelled)";
    const row = perScenario.get(scenario) ?? { scenario, total: 0, eligible: 0 };
    row.total += 1;
    if (isEligible) row.eligible += 1;
    perScenario.set(scenario, row);
  };
  for (const r of db.prepare("SELECT customer_id, status FROM cart_abandonment_events").all() as {
    customer_id: string;
    status: string;
  }[])
    bump(r.customer_id, r.status !== "paid");
  for (const r of db.prepare("SELECT customer_id, status FROM subscription_failure_events").all() as {
    customer_id: string;
    status: string;
  }[])
    bump(r.customer_id, r.status === "failed" || r.status === "halted");
  for (const r of db.prepare("SELECT customer_id, status FROM dispute_events").all() as {
    customer_id: string;
    status: string;
  }[])
    bump(r.customer_id, r.status === "open" || r.status === "under_review");
} catch {
  // Estimator still works without the labels file; the split is just omitted.
}

const calls = totalEligible * ARMS;
const inputCostStd = (calls * inputTokens * USD_PER_MTOK_INPUT) / 1_000_000;
const outputCostStd = (calls * outputTokens * USD_PER_MTOK_OUTPUT) / 1_000_000;
const standard = inputCostStd + outputCostStd;
const batch = standard * BATCH_DISCOUNT;

const usd = (n: number): string => `$${n.toFixed(2)}`;
const pct = (a: number, b: number): string => (b === 0 ? "—" : `${((a / b) * 100).toFixed(1)}%`);

console.log(`\nRun cost estimate — ${customers} customers, ${totalEvents} events\n`);

console.log("Events by domain");
console.log("  domain                total   eligible   share");
for (const [name, key] of [
  ["cart_abandonment", "cart"],
  ["subscription_recovery", "subscription"],
  ["dispute_responder", "dispute"],
] as const) {
  const t = totals[key];
  const e = eligible[key];
  console.log(`  ${name.padEnd(22)}${String(t).padStart(5)}${String(e).padStart(11)}${pct(e, t).padStart(8)}`);
}
console.log(`  ${"TOTAL".padEnd(22)}${String(totalEvents).padStart(5)}${String(totalEligible).padStart(11)}${pct(totalEligible, totalEvents).padStart(8)}`);

if (perScenario.size > 0) {
  console.log("\nRecovery-eligible events by scenario");
  console.log("  scenario                        total   eligible   share");
  const rows = [...perScenario.values()].sort((a, b) => b.eligible - a.eligible);
  for (const r of rows) {
    console.log(
      `  ${r.scenario.padEnd(30)}${String(r.total).padStart(5)}${String(r.eligible).padStart(11)}${pct(r.eligible, r.total).padStart(8)}`,
    );
  }
}

console.log("\nRun shape");
console.log(`  eligible events               ${totalEligible}`);
console.log(`  eligible events per customer  ${(totalEligible / Math.max(customers, 1)).toFixed(2)}`);
console.log(`  arms                          ${ARMS} (baseline + memory)`);
console.log(`  total API calls               ${calls}`);

console.log("\nProjected cost");
console.log(`  assumed tokens per call       ${inputTokens} in / ${outputTokens} out${usingDefaults ? "  (DEFAULTS — not measured)" : "  (overridden)"}`);
console.log(`  input                         ${usd(inputCostStd)} standard`);
console.log(`  output                        ${usd(outputCostStd)} standard`);
console.log(`  ---`);
console.log(`  standard API                  ${usd(standard)}   <- what agents:baseline + agents:memory cost today`);
console.log(`  batch API (${BATCH_DISCOUNT * 100}%)              ${usd(batch)}   <- if moved to the Batch API`);

const skipped = totalEvents - totalEligible;
if (skipped > 0) {
  const wouldHaveCost = (skipped * ARMS * (inputTokens * USD_PER_MTOK_INPUT + outputTokens * USD_PER_MTOK_OUTPUT)) / 1_000_000;
  console.log(
    `\n  ${skipped} ineligible events (${pct(skipped, totalEvents)}) are skipped, saving ${usd(wouldHaveCost)} standard / ${usd(wouldHaveCost * BATCH_DISCOUNT)} batch.`,
  );
  console.log("  They stay in the database and are still read by the asOf profile queries.");
}

if (usingDefaults) {
  console.log("\n  Token figures are estimates, not measurements — the largest error term here.");
  console.log("  Re-run with --input-tokens=N --output-tokens=N once real per-call usage is known.");
}
console.log("");

db.close();
