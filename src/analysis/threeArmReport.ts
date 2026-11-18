// Three arms side by side, from the database: baseline, memory and agentic.
//
// Reads the isolated database named by CROSS_AGENT_MEMORY_DB_PATH (through
// scripts/runIsolated.sh when unset). Compares only events that ALL THREE arms
// decided, so every row is the same set of events. Scenario labels come from
// data/generated/scenario_labels.json and are used here only, in the outcome
// layer; no agent sees them.
//
// Net is the same rule as the scoring: collected - discount - escalation
// handling (ESCALATION_HANDLING_COST_PAISE per escalated decision). Sample sizes
// are small. Read the numbers as directional, not significant.
import { openDb } from "../db/connection.js";
import { ESCALATION_HANDLING_COST_PAISE } from "../outcomes/probabilities.js";
import { loadScenarioByCustomer } from "../agentic/outcomes.js";

type Arm = "baseline" | "memory" | "agentic";
const ARMS: Arm[] = ["baseline", "memory", "agentic"];

interface Decision {
  action: string;
  escalated: boolean;
  fallback: boolean;
  spend: number;
  customerId: string;
}

interface Outcome {
  converted: boolean;
  collected: number;
  spend: number;
}

function pct(numerator: number, denominator: number): string {
  return denominator === 0 ? "n/a" : `${((100 * numerator) / denominator).toFixed(1)}%`;
}

function main(): void {
  const db = openDb();

  // Latest decision per (event, arm): a re-decide replaces, so take the last row.
  const decisions = new Map<string, Map<Arm, Decision>>();
  const decisionRows = db
    .prepare(
      `SELECT customer_id, event_id, mode, action, escalate_to_human, policy_override
       FROM audit_log WHERE entry_type = 'decision' AND mode IS NOT NULL AND event_id IS NOT NULL
       ORDER BY rowid`,
    )
    .all() as Array<{
    customer_id: string;
    event_id: string;
    mode: Arm;
    action: string;
    escalate_to_human: number | null;
    policy_override: string | null;
  }>;
  for (const row of decisionRows) {
    const fallback = row.policy_override !== null &&
      (JSON.parse(row.policy_override) as { original_action?: string }).original_action === "unvalidated_model_output";
    const byArm = decisions.get(row.event_id) ?? new Map<Arm, Decision>();
    byArm.set(row.mode, {
      action: row.action,
      escalated: row.escalate_to_human === 1,
      fallback,
      spend: 0,
      customerId: row.customer_id,
    });
    decisions.set(row.event_id, byArm);
  }

  // Spend: discount_usage, which every arm writes. One row per (event, mode).
  for (const row of db
    .prepare(`SELECT event_id, mode, SUM(amount) AS spend FROM discount_usage GROUP BY event_id, mode`)
    .all() as Array<{ event_id: string; mode: Arm; spend: number }>) {
    const d = decisions.get(row.event_id)?.get(row.mode);
    if (d) d.spend = row.spend;
  }

  // Outcomes per (event, arm), recorded by the same rules for every arm.
  const outcomes = new Map<string, Map<Arm, Outcome>>();
  for (const row of db
    .prepare(
      `SELECT event_id, mode, converted, amount_collected_paise, committed_spend_paise
       FROM intervention_outcomes ORDER BY id`,
    )
    .all() as Array<{
    event_id: string;
    mode: Arm;
    converted: number;
    amount_collected_paise: number;
    committed_spend_paise: number | null;
  }>) {
    const byArm = outcomes.get(row.event_id) ?? new Map<Arm, Outcome>();
    byArm.set(row.mode, {
      converted: row.converted === 1,
      collected: row.amount_collected_paise,
      spend: row.committed_spend_paise ?? 0,
    });
    outcomes.set(row.event_id, byArm);
  }
  db.close();

  // Only events all three arms decided.
  const common = [...decisions.entries()].filter(([, byArm]) => ARMS.every((arm) => byArm.has(arm)));
  if (common.length === 0) {
    console.log("No events decided by all three arms. Run the three arms on the same events first.");
    return;
  }

  const scenarios = loadScenarioByCustomer();
  console.log(`Events decided by all three arms: ${common.length}\n`);

  type Tally = {
    n: number;
    spend: number;
    escalated: number;
    fallback: number;
    converted: number;
    outcomes: number;
    collected: number;
    net: number;
    discounts: number;
  };
  const empty = (): Tally => ({
    n: 0, spend: 0, escalated: 0, fallback: 0, converted: 0, outcomes: 0, collected: 0, net: 0, discounts: 0,
  });
  const tally = (
    rows: Array<[string, Map<Arm, Decision>]>,
    arm: Arm,
  ): Tally => {
    const t = empty();
    for (const [eventId, byArm] of rows) {
      const d = byArm.get(arm)!;
      t.n += 1;
      t.spend += d.spend;
      if (d.spend > 0) t.discounts += 1;
      if (d.escalated) t.escalated += 1;
      if (d.fallback) t.fallback += 1;
      const o = outcomes.get(eventId)?.get(arm);
      if (o) {
        t.outcomes += 1;
        if (o.converted) t.converted += 1;
        t.collected += o.collected;
        t.net += o.collected - d.spend - (d.escalated ? ESCALATION_HANDLING_COST_PAISE : 0);
      }
    }
    return t;
  };

  console.log("OVERALL");
  console.log(
    "arm       | decisions | discounted | avg discount paise | total discount paise | escalation | human-review fallback | conversion | net paise",
  );
  for (const arm of ARMS) {
    const t = tally(common, arm);
    console.log(
      `${arm.padEnd(9)} | ${String(t.n).padStart(9)} | ${pct(t.discounts, t.n).padStart(10)} | ` +
        `${(t.spend / t.n).toFixed(0).padStart(18)} | ${String(t.spend).padStart(20)} | ` +
        `${pct(t.escalated, t.n).padStart(10)} | ${pct(t.fallback, t.n).padStart(21)} | ` +
        `${pct(t.converted, t.outcomes).padStart(10)} | ${t.net}`,
    );
  }

  console.log("\nBY SCENARIO (n events; discount avg paise; escalation; conversion)");
  const byScenario = new Map<string, Array<[string, Map<Arm, Decision>]>>();
  for (const entry of common) {
    const customer = entry[1].get("baseline")!.customerId;
    const scenario = scenarios.get(customer) ?? "unlabelled";
    byScenario.set(scenario, [...(byScenario.get(scenario) ?? []), entry]);
  }
  console.log("scenario                      | arm      | n  | avg discount | escalation | conversion");
  for (const scenario of [...byScenario.keys()].sort()) {
    const rows = byScenario.get(scenario)!;
    for (const arm of ARMS) {
      const t = tally(rows, arm);
      console.log(
        `${scenario.padEnd(29)} | ${arm.padEnd(8)} | ${String(t.n).padStart(2)} | ` +
          `${(t.spend / t.n).toFixed(0).padStart(12)} | ${pct(t.escalated, t.n).padStart(10)} | ` +
          `${pct(t.converted, t.outcomes).padStart(10)}`,
      );
    }
  }
}

main();
