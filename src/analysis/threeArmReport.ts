// Three arms side by side, from the database: baseline, memory and agentic.
//
// Where each arm's final decision comes from, in order:
//   1. the arm's decision row in audit_log, when the run wrote one (the runner and
//      the agentic arm do);
//   2. otherwise the final decision in its policy_override trace step, which every
//      decide path writes after the guardrail. Compare runs of baseline and
//      memory used to rely on this alone, because they wrote no decision row.
// Spend is the decision's committed_spend_paise, the same for every arm.
// Outcomes come from intervention_outcomes, recorded by the same rules for all arms.
//
// Only events that ALL THREE arms decided are compared, so every row covers the
// same events. Scenario labels come from data/generated/scenario_labels.json and
// are used only here, in the outcome layer. No agent sees them.
//
// Net is collected - spend - escalation handling (ESCALATION_HANDLING_COST_PAISE
// per escalated decision), the scoring constant. Sample sizes are small.
import type Database from "better-sqlite3";
import { openDb } from "../db/connection.js";
import { ESCALATION_HANDLING_COST_PAISE } from "../outcomes/probabilities.js";
import { loadScenarioByCustomer } from "../agentic/outcomes.js";

export type Arm = "baseline" | "memory" | "agentic";
export const ARMS: Arm[] = ["baseline", "memory", "agentic"];

export interface ArmDecision {
  action: string;
  escalated: boolean;
  fallback: boolean;
  spend: number;
  customerId: string;
  source: "audit" | "trace";
}

export interface ArmOutcome {
  converted: boolean;
  collected: number;
  spend: number;
}

export interface CollectedArms {
  // event_id -> arm -> the arm's final decision, for events every arm decided.
  common: Array<[string, Map<Arm, ArmDecision>]>;
  // Every (event, arm) decision, whether or not all three arms decided it.
  decisionsByEvent: Map<string, Map<Arm, ArmDecision>>;
  outcomes: Map<string, Map<Arm, ArmOutcome>>;
}

export function collectArms(db: Database.Database): CollectedArms {
  const decisionsByEvent = new Map<string, Map<Arm, ArmDecision>>();
  const put = (eventId: string, arm: Arm, decision: ArmDecision) => {
    const byArm = decisionsByEvent.get(eventId) ?? new Map<Arm, ArmDecision>();
    byArm.set(arm, decision);
    decisionsByEvent.set(eventId, byArm);
  };

  // 1. Audit decision rows. Latest per (event, arm): a re-decide replaces.
  for (const row of db
    .prepare(
      `SELECT customer_id, event_id, mode, action, escalate_to_human, policy_override, metadata
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
    metadata: string | null;
  }>) {
    const override = row.policy_override ? (JSON.parse(row.policy_override) as { original_action?: string }) : null;
    const meta = row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {};
    const spend = Number(meta.committed_spend_paise ?? meta.discount_amount ?? 0);
    put(row.event_id, row.mode, {
      action: row.action,
      escalated: row.escalate_to_human === 1,
      fallback: override?.original_action === "unvalidated_model_output",
      spend,
      customerId: row.customer_id,
      source: "audit",
    });
  }

  // 2. Trace fallback for any (event, arm) with no audit row.
  for (const row of db
    .prepare(
      `SELECT customer_id, event_id, mode, detail FROM agent_trace_events
       WHERE step_name = 'policy_override' ORDER BY rowid`,
    )
    .all() as Array<{ customer_id: string; event_id: string; mode: Arm; detail: string }>) {
    const existing = decisionsByEvent.get(row.event_id)?.get(row.mode);
    if (existing?.source === "audit") continue;
    const final = (JSON.parse(row.detail) as {
      final?: { action: string; committed_spend_paise: number | null; escalate_to_human: boolean };
    }).final;
    if (!final) continue;
    put(row.event_id, row.mode, {
      action: final.action,
      escalated: final.escalate_to_human === true,
      fallback: false,
      spend: final.committed_spend_paise ?? 0,
      customerId: row.customer_id,
      source: "trace",
    });
  }

  // Outcomes per (event, arm), recorded by the same rules for every arm.
  const outcomes = new Map<string, Map<Arm, ArmOutcome>>();
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
    const byArm = outcomes.get(row.event_id) ?? new Map<Arm, ArmOutcome>();
    byArm.set(row.mode, {
      converted: row.converted === 1,
      collected: row.amount_collected_paise,
      spend: row.committed_spend_paise ?? 0,
    });
    outcomes.set(row.event_id, byArm);
  }

  const common = [...decisionsByEvent.entries()].filter(([, byArm]) =>
    ARMS.every((arm) => byArm.has(arm)),
  );
  return { common, decisionsByEvent, outcomes };
}

type Tally = {
  n: number;
  spend: number;
  discounted: number;
  escalated: number;
  fallback: number;
  converted: number;
  outcomes: number;
  collected: number;
  net: number;
};

export function tallyArm(
  rows: Array<[string, Map<Arm, ArmDecision>]>,
  arm: Arm,
  outcomes: Map<string, Map<Arm, ArmOutcome>>,
): Tally {
  const t: Tally = {
    n: 0, spend: 0, discounted: 0, escalated: 0, fallback: 0, converted: 0, outcomes: 0, collected: 0, net: 0,
  };
  for (const [eventId, byArm] of rows) {
    const d = byArm.get(arm)!;
    t.n += 1;
    t.spend += d.spend;
    if (d.spend > 0) t.discounted += 1;
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
}

function pct(numerator: number, denominator: number): string {
  return denominator === 0 ? "n/a" : `${((100 * numerator) / denominator).toFixed(1)}%`;
}

function main(): void {
  const db = openDb();
  const { common, decisionsByEvent, outcomes } = collectArms(db);
  db.close();

  const perArm = ARMS.map((arm) => {
    const count = [...decisionsByEvent.values()].filter((byArm) => byArm.has(arm)).length;
    const sources = [...decisionsByEvent.values()]
      .map((byArm) => byArm.get(arm)?.source)
      .filter((s): s is "audit" | "trace" => s !== undefined);
    return `${arm}: ${count} decisions (audit ${sources.filter((s) => s === "audit").length}, trace ${sources.filter((s) => s === "trace").length})`;
  });
  console.log(`Decisions found per arm: ${perArm.join("; ")}`);

  if (common.length === 0) {
    console.log("No events decided by all three arms. Run the three arms on the same events first.");
    return;
  }

  const scenarios = loadScenarioByCustomer();
  console.log(`Events decided by all three arms: ${common.length}\n`);

  console.log("OVERALL");
  console.log(
    "arm       | decisions | discounted | avg discount paise | total discount paise | escalation | human-review fallback | conversion | net paise",
  );
  for (const arm of ARMS) {
    const t = tallyArm(common, arm, outcomes);
    console.log(
      `${arm.padEnd(9)} | ${String(t.n).padStart(9)} | ${pct(t.discounted, t.n).padStart(10)} | ` +
        `${(t.spend / t.n).toFixed(0).padStart(18)} | ${String(t.spend).padStart(20)} | ` +
        `${pct(t.escalated, t.n).padStart(10)} | ${pct(t.fallback, t.n).padStart(21)} | ` +
        `${pct(t.converted, t.outcomes).padStart(10)} | ${t.net}`,
    );
  }

  console.log("\nBY SCENARIO (n events; avg discount paise; escalation; conversion)");
  const byScenario = new Map<string, Array<[string, Map<Arm, ArmDecision>]>>();
  for (const entry of common) {
    const customer = entry[1].get("baseline")!.customerId;
    const scenario = scenarios.get(customer) ?? "unlabelled";
    byScenario.set(scenario, [...(byScenario.get(scenario) ?? []), entry]);
  }
  console.log("scenario                      | arm      | n  | avg discount | escalation | conversion");
  for (const scenario of [...byScenario.keys()].sort()) {
    const rows = byScenario.get(scenario)!;
    for (const arm of ARMS) {
      const t = tallyArm(rows, arm, outcomes);
      console.log(
        `${scenario.padEnd(29)} | ${arm.padEnd(8)} | ${String(t.n).padStart(2)} | ` +
          `${(t.spend / t.n).toFixed(0).padStart(12)} | ${pct(t.escalated, t.n).padStart(10)} | ` +
          `${pct(t.converted, t.outcomes).padStart(10)}`,
      );
    }
  }
}

// Run only when executed directly, so the functions above can be imported by tests.
if (process.argv[1] && import.meta.filename === process.argv[1]) {
  main();
}
