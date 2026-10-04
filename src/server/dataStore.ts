import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Scenario, ScenarioLabel } from "../data/generator.js";
import type {
  AgentType,
  CartAbandonmentEvent,
  Customer,
  DisputeEvent,
  SubscriptionFailureEvent,
} from "../types/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GENERATED_DIR = join(__dirname, "..", "..", "data", "generated");
const RESULTS_DIR = join(__dirname, "..", "..", "data", "results");

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

export interface TimelineEvent {
  domain: AgentType;
  event_id: string;
  timestamp: string;
  detail: CartAbandonmentEvent | SubscriptionFailureEvent | DisputeEvent;
}

export interface DecisionRecord {
  agent: AgentType;
  customer_id: string;
  event_id: string;
  action: string;
  committed_spend_paise: number | null;
  escalate_to_human: boolean;
  escalation_reason: string | null;
  reasoning: string;
  memory_factors_used: string[];
  policy_version?: string;
}

export interface ComparisonReport {
  overall: Record<string, number>;
  byScenario: Record<string, unknown>[];
  crossDomainSuppression: Record<string, unknown>;
}

class DataStore {
  readonly customers: Customer[];
  readonly scenarioByCustomer: Map<string, Scenario>;
  readonly noteByCustomer: Map<string, string>;
  readonly eventsByCustomer: Map<string, TimelineEvent[]>;
  readonly baselineDecisionsByCustomer: Map<string, DecisionRecord[]>;
  readonly memoryDecisionsByCustomer: Map<string, DecisionRecord[]>;
  readonly comparisonReport: ComparisonReport;

  constructor() {
    this.customers = readJson<Customer[]>(join(GENERATED_DIR, "customers.json"));
    const scenarioLabels = readJson<ScenarioLabel[]>(join(GENERATED_DIR, "scenario_labels.json"));
    this.scenarioByCustomer = new Map(scenarioLabels.map((l) => [l.customer_id, l.scenario]));
    this.noteByCustomer = new Map(scenarioLabels.map((l) => [l.customer_id, l.note]));

    const cartEvents = readJson<CartAbandonmentEvent[]>(join(GENERATED_DIR, "cart_abandonment_events.json"));
    const subEvents = readJson<SubscriptionFailureEvent[]>(
      join(GENERATED_DIR, "subscription_failure_events.json"),
    );
    const disputeEvents = readJson<DisputeEvent[]>(join(GENERATED_DIR, "dispute_events.json"));

    // Same normalisation the runner does: each table's natural primary key
    // becomes the generic `event_id` the decision records and the frontend
    // join on.
    const allEvents: TimelineEvent[] = [
      ...cartEvents.map(
        (e): TimelineEvent => ({ domain: "cart_abandonment", event_id: e.order_id, timestamp: e.created_at, detail: e }),
      ),
      ...subEvents.map(
        (e): TimelineEvent => ({
          domain: "subscription_recovery",
          event_id: e.payment_id,
          timestamp: e.created_at,
          detail: e,
        }),
      ),
      ...disputeEvents.map(
        (e): TimelineEvent => ({ domain: "dispute_responder", event_id: e.dispute_id, timestamp: e.dispute_created_at, detail: e }),
      ),
    ];

    this.eventsByCustomer = new Map();
    for (const e of allEvents) {
      const list = this.eventsByCustomer.get(e.detail.customer_id) ?? [];
      list.push(e);
      this.eventsByCustomer.set(e.detail.customer_id, list);
    }
    for (const list of this.eventsByCustomer.values()) {
      list.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    }

    this.baselineDecisionsByCustomer = groupByCustomer(
      readJson<DecisionRecord[]>(join(RESULTS_DIR, "baseline_decisions.json")),
    );
    this.memoryDecisionsByCustomer = groupByCustomer(
      readJson<DecisionRecord[]>(join(RESULTS_DIR, "memory_decisions.json")),
    );
    this.comparisonReport = readJson<ComparisonReport>(join(RESULTS_DIR, "comparison_report.json"));
  }
}

function groupByCustomer(decisions: DecisionRecord[]): Map<string, DecisionRecord[]> {
  const map = new Map<string, DecisionRecord[]>();
  for (const d of decisions) {
    const list = map.get(d.customer_id) ?? [];
    list.push(d);
    map.set(d.customer_id, list);
  }
  return map;
}

let store: DataStore | null = null;
export function getDataStore(): DataStore {
  if (!store) store = new DataStore();
  return store;
}
