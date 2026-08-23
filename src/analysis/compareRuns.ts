import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Scenario, ScenarioLabel } from "../data/generator.js";
import type { AgentType, CartAbandonmentEvent } from "../types/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, "..", "..", "data", "results");
const GENERATED_DIR = join(__dirname, "..", "..", "data", "generated");

interface DecisionRecord {
  agent: AgentType;
  customer_id: string;
  event_id: string;
  action: string;
  discount_amount: number | null;
  escalate_to_human: boolean;
  reasoning: string;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

interface CustomerRollup {
  scenario: Scenario;
  events: number;
  baselineDiscount: number;
  memoryDiscount: number;
  baselineEscalations: number;
  memoryEscalations: number;
}

interface ScenarioRollup {
  scenario: Scenario;
  customers: number;
  events: number;
  baselineDiscountPaise: number;
  memoryDiscountPaise: number;
  discountAvoidedPaise: number;
  baselineEscalations: number;
  memoryEscalations: number;
}

function main(): void {
  const scenarioLabels = readJson<ScenarioLabel[]>(join(GENERATED_DIR, "scenario_labels.json"));
  const baseline = readJson<DecisionRecord[]>(join(RESULTS_DIR, "baseline_decisions.json"));
  const memory = readJson<DecisionRecord[]>(join(RESULTS_DIR, "memory_decisions.json"));
  const cartEvents = readJson<CartAbandonmentEvent[]>(join(GENERATED_DIR, "cart_abandonment_events.json"));

  const scenarioByCustomer = new Map(scenarioLabels.map((l) => [l.customer_id, l.scenario]));
  const memoryByEvent = new Map(memory.map((d) => [d.event_id, d]));

  const rollups = new Map<string, CustomerRollup>();

  for (const b of baseline) {
    const m = memoryByEvent.get(b.event_id);
    if (!m) continue; // memory run hasn't covered this event (e.g. still in progress)

    const scenario = scenarioByCustomer.get(b.customer_id) ?? "normal";
    const existing = rollups.get(b.customer_id) ?? {
      scenario,
      events: 0,
      baselineDiscount: 0,
      memoryDiscount: 0,
      baselineEscalations: 0,
      memoryEscalations: 0,
    };

    existing.events += 1;
    existing.baselineDiscount += b.discount_amount ?? 0;
    existing.memoryDiscount += m.discount_amount ?? 0;
    existing.baselineEscalations += b.escalate_to_human ? 1 : 0;
    existing.memoryEscalations += m.escalate_to_human ? 1 : 0;
    rollups.set(b.customer_id, existing);
  }

  const scenarioRollups = new Map<Scenario, ScenarioRollup>();
  for (const r of rollups.values()) {
    const existing = scenarioRollups.get(r.scenario) ?? {
      scenario: r.scenario,
      customers: 0,
      events: 0,
      baselineDiscountPaise: 0,
      memoryDiscountPaise: 0,
      discountAvoidedPaise: 0,
      baselineEscalations: 0,
      memoryEscalations: 0,
    };
    existing.customers += 1;
    existing.events += r.events;
    existing.baselineDiscountPaise += r.baselineDiscount;
    existing.memoryDiscountPaise += r.memoryDiscount;
    existing.discountAvoidedPaise += Math.max(0, r.baselineDiscount - r.memoryDiscount);
    existing.baselineEscalations += r.baselineEscalations;
    existing.memoryEscalations += r.memoryEscalations;
    scenarioRollups.set(r.scenario, existing);
  }

  const overall = {
    matchedEvents: [...rollups.values()].reduce((sum, r) => sum + r.events, 0),
    customers: rollups.size,
    baselineDiscountPaise: [...rollups.values()].reduce((sum, r) => sum + r.baselineDiscount, 0),
    memoryDiscountPaise: [...rollups.values()].reduce((sum, r) => sum + r.memoryDiscount, 0),
    baselineEscalations: [...rollups.values()].reduce((sum, r) => sum + r.baselineEscalations, 0),
    memoryEscalations: [...rollups.values()].reduce((sum, r) => sum + r.memoryEscalations, 0),
  };
  const discountAvoidedPaise = Math.max(0, overall.baselineDiscountPaise - overall.memoryDiscountPaise);

  // Targeted check: for cross_domain_risk customers, the generator plants a
  // paid order, then a dispute on it, then a LATER (non-paid) abandoned cart
  // that a memory-aware agent should treat more cautiously than baseline.
  const crossDomainSuppression = checkCrossDomainSuppression(scenarioLabels, cartEvents, baseline, memory);

  const report = {
    overall: { ...overall, discountAvoidedPaise },
    byScenario: [...scenarioRollups.values()].sort((a, b) => b.discountAvoidedPaise - a.discountAvoidedPaise),
    crossDomainSuppression,
  };

  writeFileSync(join(RESULTS_DIR, "comparison_report.json"), JSON.stringify(report, null, 2) + "\n", "utf-8");

  console.log(JSON.stringify(report, null, 2));
  console.log(`\nWrote ${join(RESULTS_DIR, "comparison_report.json")}`);
}

interface CrossDomainSuppressionResult {
  customersChecked: number;
  suppressed: number; // memory discount strictly less than baseline on the later cart
  unchanged: number;
  details: {
    customer_id: string;
    event_id: string;
    baselineDiscount: number | null;
    memoryDiscount: number | null;
  }[];
}

function checkCrossDomainSuppression(
  scenarioLabels: ScenarioLabel[],
  cartEvents: CartAbandonmentEvent[],
  baseline: DecisionRecord[],
  memory: DecisionRecord[],
): CrossDomainSuppressionResult {
  const crossDomainCustomers = new Set(
    scenarioLabels.filter((l) => l.scenario === "cross_domain_risk").map((l) => l.customer_id),
  );

  // The generator plants exactly one non-paid cart event per
  // cross_domain_risk customer — the "later" abandoned cart that follows a
  // dispute on their earlier paid order. Pick it directly from the event
  // data rather than guessing from decisions, which can pick the wrong
  // (already-paid) event when neither run happened to discount it.
  const targetEventByCustomer = new Map<string, string>();
  for (const e of cartEvents) {
    if (e.status !== "paid" && crossDomainCustomers.has(e.customer_id)) {
      targetEventByCustomer.set(e.customer_id, e.event_id);
    }
  }

  const baselineByEvent = new Map(baseline.map((d) => [d.event_id, d]));
  const memoryByEvent = new Map(memory.map((d) => [d.event_id, d]));

  const details: CrossDomainSuppressionResult["details"] = [];
  for (const [customerId, eventId] of targetEventByCustomer) {
    const b = baselineByEvent.get(eventId);
    const m = memoryByEvent.get(eventId);
    if (!b || !m) continue;
    details.push({
      customer_id: customerId,
      event_id: eventId,
      baselineDiscount: b.discount_amount,
      memoryDiscount: m.discount_amount,
    });
  }

  const suppressed = details.filter((d) => (d.memoryDiscount ?? 0) < (d.baselineDiscount ?? 0)).length;
  const unchanged = details.length - suppressed;

  return { customersChecked: details.length, suppressed, unchanged, details };
}

main();
