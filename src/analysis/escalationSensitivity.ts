import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Scenario, ScenarioLabel } from "../data/generator.js";
import {
  DEFAULT_ESCALATION_MODEL,
  resolveDisputeResponseOutcome,
  resolveRecoveryOutcome,
  rollsForEvent,
  type DecisionOutcome,
  type EscalationModel,
} from "../outcomes/resolveOutcomes.js";
import type { CartAbandonmentEvent, DisputeEvent, SubscriptionFailureEvent } from "../types/index.js";
import {
  buildDisputeAmountByEvent,
  buildDisputeGamingThresholdEvents,
  buildGrossAmountByEvent,
  readJson,
  GENERATED_DIR,
  RESULTS_DIR,
  type DecisionRecord,
} from "./scoringInputs.js";

// Sensitivity analysis for the escalation assumption — the most load-bearing
// and most attackable input to the headline comparison. It re-scores the
// decisions ALREADY recorded in data/results/ under alternative assumptions;
// no agent runs, no new API calls, and the decisions themselves never change.
// Only the scoring layer varies, so any movement in the lift is attributable
// to the assumption and nothing else.

interface Setting {
  id: string;
  label: string;
  rationale: string;
  model: EscalationModel;
  // When true, an event is dropped from BOTH arms if EITHER arm escalated,
  // removing the assumption instead of re-parameterising it.
  excludeEscalatedEvents: boolean;
}

const ESCALATION_HANDLING_COST_REALISTIC_PAISE = 150_000; // ₹1,500

const SETTINGS: Setting[] = [
  {
    id: "current",
    label: "Current",
    rationale:
      "As shipped: an escalated recovery decision converts at the scenario's pays-WITH-discount probability and costs a flat ₹300. Makes escalation strictly dominant — a discount's upside with no margin spent.",
    model: DEFAULT_ESCALATION_MODEL,
    excludeEscalatedEvents: false,
  },
  {
    id: "pessimistic",
    label: "Pessimistic conversion",
    rationale:
      "A human touch adds nothing over doing nothing: escalation converts at the pays-WITHOUT-discount probability, still ₹300. This is the adversarial reading of the assumption.",
    model: { convertsAt: "without_discount", handlingCostPaise: DEFAULT_ESCALATION_MODEL.handlingCostPaise },
    excludeEscalatedEvents: false,
  },
  {
    id: "realistic_cost",
    label: "Realistic handling cost",
    rationale:
      "Conversion unchanged, but a human review costs ₹1,500 rather than ₹300 — more than fifteen minutes of staff time. Tests whether the lift survives escalation being genuinely expensive.",
    model: { convertsAt: "with_discount", handlingCostPaise: ESCALATION_HANDLING_COST_REALISTIC_PAISE },
    excludeEscalatedEvents: false,
  },
  {
    id: "escalation_excluded",
    label: "Escalation excluded (paired)",
    rationale:
      "Scores only events where NEITHER arm escalated, removing the assumption entirely rather than re-parameterising it. Exclusion must be paired — dropping an event from one arm only would let the other arm bank revenue on an event its counterpart never got to score, which is the asymmetry the priced-escalation model was written to avoid (see compareRuns.ts methodology.escalation).",
    model: DEFAULT_ESCALATION_MODEL,
    excludeEscalatedEvents: true,
  },
];

interface ArmTotals {
  scoredEvents: number;
  paid: number;
  escalated: number;
  netRevenuePaise: number;
}

function emptyTotals(): ArmTotals {
  return { scoredEvents: 0, paid: 0, escalated: 0, netRevenuePaise: 0 };
}

function add(acc: ArmTotals, outcome: DecisionOutcome): void {
  acc.scoredEvents += 1;
  if (outcome.paid) acc.paid += 1;
  if (outcome.escalation_cost > 0) acc.escalated += 1;
  acc.netRevenuePaise += outcome.net_revenue;
}

interface Cell {
  baseline: ArmTotals;
  memory: ArmTotals;
}

function emptyCell(): Cell {
  return { baseline: emptyTotals(), memory: emptyTotals() };
}

function score(setting: Setting): {
  overall: Cell;
  byScenario: Record<string, Cell>;
  droppedEvents: number;
} {
  const scenarioLabels = readJson<ScenarioLabel[]>(join(GENERATED_DIR, "scenario_labels.json"));
  const baseline = readJson<DecisionRecord[]>(join(RESULTS_DIR, "baseline_decisions.json"));
  const memory = readJson<DecisionRecord[]>(join(RESULTS_DIR, "memory_decisions.json"));
  const cartEvents = readJson<CartAbandonmentEvent[]>(join(GENERATED_DIR, "cart_abandonment_events.json"));
  const subEvents = readJson<SubscriptionFailureEvent[]>(join(GENERATED_DIR, "subscription_failure_events.json"));
  const disputeEvents = readJson<DisputeEvent[]>(join(GENERATED_DIR, "dispute_events.json"));

  const scenarioByCustomer = new Map(scenarioLabels.map((l) => [l.customer_id, l.scenario]));
  const memoryByEvent = new Map(memory.map((d) => [d.event_id, d]));
  const grossAmountByEvent = buildGrossAmountByEvent(cartEvents, subEvents);
  const disputeAmountByEvent = buildDisputeAmountByEvent(disputeEvents);
  const disputeGamingEligible = buildDisputeGamingThresholdEvents(disputeEvents);

  const overall = emptyCell();
  const byScenario: Record<string, Cell> = {};
  let droppedEvents = 0;

  for (const b of baseline) {
    const m = memoryByEvent.get(b.event_id);
    if (!m) continue;

    // Paired: either arm escalating drops the event from BOTH.
    if (setting.excludeEscalatedEvents && (b.escalate_to_human || m.escalate_to_human)) {
      droppedEvents += 1;
      continue;
    }

    const scenario: Scenario = scenarioByCustomer.get(b.customer_id) ?? "normal";
    const cell = (byScenario[scenario] ??= emptyCell());

    const grossAmount = grossAmountByEvent.get(b.event_id);
    const disputeAmount = disputeAmountByEvent.get(b.event_id);

    if (grossAmount != null && (b.agent === "cart_abandonment" || b.agent === "subscription_recovery")) {
      // Identical dice for both arms, exactly as compareRuns.ts does — only
      // the decision and the escalation model may differ.
      const rolls = rollsForEvent(b.event_id);
      const bo = resolveRecoveryOutcome(b.event_id, b.agent, scenario, grossAmount, b, rolls, setting.model);
      const mo = resolveRecoveryOutcome(
        m.event_id,
        m.agent as typeof b.agent,
        scenario,
        grossAmount,
        m,
        rolls,
        setting.model,
      );
      add(cell.baseline, bo);
      add(cell.memory, mo);
      add(overall.baseline, bo);
      add(overall.memory, mo);
    } else if (disputeAmount != null && b.agent === "dispute_responder" && disputeGamingEligible.has(b.event_id)) {
      const bo = resolveDisputeResponseOutcome(b.event_id, scenario, disputeAmount, b, setting.model);
      const mo = resolveDisputeResponseOutcome(m.event_id, scenario, disputeAmount, m, setting.model);
      add(cell.baseline, bo);
      add(cell.memory, mo);
      add(overall.baseline, bo);
      add(overall.memory, mo);
    }
  }

  return { overall, byScenario, droppedEvents };
}

function rupees(paise: number): string {
  const sign = paise < 0 ? "-" : "";
  return `${sign}₹${(Math.abs(paise) / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

const HEADLINE_SCENARIOS: Scenario[] = ["repeat_offender_cart", "cross_domain_risk"];

function main(): void {
  const results = SETTINGS.map((setting) => {
    const { overall, byScenario, droppedEvents } = score(setting);
    return { setting, overall, byScenario, droppedEvents };
  });

  console.log("=== Escalation sensitivity: memory vs baseline net revenue ===");
  console.log("Same recorded decisions throughout; only the scoring assumption varies.\n");
  console.log(
    ["assumption".padEnd(30), "scored".padStart(7), "baseline".padStart(14), "memory".padStart(14), "lift".padStart(14)].join(""),
  );
  for (const r of results) {
    const lift = r.overall.memory.netRevenuePaise - r.overall.baseline.netRevenuePaise;
    console.log(
      [
        r.setting.label.padEnd(30),
        String(r.overall.baseline.scoredEvents).padStart(7),
        rupees(r.overall.baseline.netRevenuePaise).padStart(14),
        rupees(r.overall.memory.netRevenuePaise).padStart(14),
        rupees(lift).padStart(14),
      ].join(""),
    );
  }

  for (const r of results) {
    console.log(`\n--- ${r.setting.label} ---`);
    if (r.setting.excludeEscalatedEvents) {
      console.log(`dropped ${r.droppedEvents} event(s) where either arm escalated`);
    }
    console.log(
      `escalations scored: baseline ${r.overall.baseline.escalated}, memory ${r.overall.memory.escalated} | paid: baseline ${r.overall.baseline.paid}, memory ${r.overall.memory.paid}`,
    );
    for (const scenario of HEADLINE_SCENARIOS) {
      const cell = r.byScenario[scenario];
      if (!cell || cell.baseline.scoredEvents === 0) {
        console.log(`  ${scenario.padEnd(22)} no scoreable events remain`);
        continue;
      }
      const lift = cell.memory.netRevenuePaise - cell.baseline.netRevenuePaise;
      console.log(
        `  ${scenario.padEnd(22)} n=${String(cell.baseline.scoredEvents).padStart(4)}  baseline ${rupees(cell.baseline.netRevenuePaise).padStart(12)}  memory ${rupees(cell.memory.netRevenuePaise).padStart(12)}  lift ${rupees(lift).padStart(12)}`,
      );
    }
  }

  const out = {
    note: "Sensitivity analysis over ALREADY-RECORDED decisions. No agent runs; only the escalation scoring assumption varies between settings. Claims are directional, not statistical.",
    settings: results.map((r) => ({
      id: r.setting.id,
      label: r.setting.label,
      rationale: r.setting.rationale,
      escalationModel: r.setting.model,
      excludeEscalatedEvents: r.setting.excludeEscalatedEvents,
      droppedEvents: r.droppedEvents,
      overall: {
        ...r.overall,
        netRevenueLiftPaise: r.overall.memory.netRevenuePaise - r.overall.baseline.netRevenuePaise,
      },
      byScenario: Object.fromEntries(
        Object.entries(r.byScenario).map(([k, v]) => [
          k,
          { ...v, netRevenueLiftPaise: v.memory.netRevenuePaise - v.baseline.netRevenuePaise },
        ]),
      ),
    })),
  };
  const path = join(RESULTS_DIR, "escalation_sensitivity.json");
  writeFileSync(path, JSON.stringify(out, null, 2) + "\n", "utf-8");
  console.log(`\nWrote ${path}`);
}

main();
