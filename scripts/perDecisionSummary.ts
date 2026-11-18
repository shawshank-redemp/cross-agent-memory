// Per-decision figures for the three arms, read from a compare database. Read-only:
// it never writes, and it is run through scripts/runIsolated.sh's database rule.
//
//   CROSS_AGENT_MEMORY_DB_PATH=data/compare40/compare40.sqlite npx tsx scripts/perDecisionSummary.ts
//
// Per decision: tokens (input + output), model calls, summed model latency, and
// notional cost (the same notional rate as analyze:metrics). Per action and arm:
// count, conversion, average collected. Every number is a sum or mean over rows
// in the database. Nothing is estimated.
import Database from "better-sqlite3";

const path = process.env.CROSS_AGENT_MEMORY_DB_PATH;
if (!path) throw new Error("CROSS_AGENT_MEMORY_DB_PATH must name the database to read");
const db = new Database(path, { readonly: true, fileMustExist: true });

const arms = ["baseline", "memory", "agentic"] as const;

console.log("PER DECISION (sums over every model call for the event)");
console.log("arm      | decisions | tokens/decision | model calls/decision | latency ms/decision (median) | notional cost USD/decision");
for (const arm of arms) {
  const perEvent = db
    .prepare(
      `SELECT event_id, COUNT(*) AS calls, SUM(input_tokens + output_tokens) AS tokens,
              SUM(latency_ms) AS latency, SUM(COALESCE(cost_usd, 0)) AS cost
       FROM llm_call_metrics WHERE mode = ? GROUP BY event_id`,
    )
    .all(arm) as Array<{ event_id: string; calls: number; tokens: number; latency: number; cost: number }>;
  if (perEvent.length === 0) continue;
  const n = perEvent.length;
  const sum = (f: (r: (typeof perEvent)[number]) => number) => perEvent.reduce((a, r) => a + f(r), 0);
  const latencies = perEvent.map((r) => r.latency).sort((a, b) => a - b);
  const median = latencies[Math.floor((latencies.length - 1) / 2)]!;
  console.log(
    `${arm.padEnd(8)} | ${String(n).padStart(9)} | ${(sum((r) => r.tokens) / n).toFixed(0).padStart(15)} | ` +
      `${(sum((r) => r.calls) / n).toFixed(2).padStart(20)} | ${String(median).padStart(28)} | ` +
      `${(sum((r) => r.cost) / n).toFixed(6)}`,
  );
}

console.log("\nBY ACTION (intervention outcomes; modelled conversion, see docs)");
console.log("arm      | action          | n  | conversion | avg collected paise");
for (const arm of arms) {
  const rows = db
    .prepare(
      `SELECT action, COUNT(*) AS n, AVG(converted) AS conv, AVG(amount_collected_paise) AS collected
       FROM intervention_outcomes WHERE mode = ? GROUP BY action ORDER BY action`,
    )
    .all(arm) as Array<{ action: string; n: number; conv: number; collected: number }>;
  for (const r of rows) {
    console.log(
      `${arm.padEnd(8)} | ${r.action.padEnd(15)} | ${String(r.n).padStart(2)} | ${(100 * r.conv).toFixed(1).padStart(9)}% | ${r.collected.toFixed(0)}`,
    );
  }
}
db.close();
