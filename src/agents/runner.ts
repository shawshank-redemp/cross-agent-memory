import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { openDb } from "../db/connection.js";
import type { Scenario, ScenarioLabel } from "../data/generator.js";
import { appendAuditLog, recordDiscountUsage } from "../memory/profile.js";
import type {
  AgentType,
  CartAbandonmentEvent,
  Customer,
  DisputeEvent,
  SubscriptionFailureEvent,
} from "../types/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, "..", "..", "data", "results");
const GENERATED_DIR = join(__dirname, "..", "..", "data", "generated");

const ALL_SCENARIOS: Scenario[] = [
  "normal",
  "repeat_offender_cart",
  "repeat_offender_subscription",
  "repeat_offender_dispute",
  "cross_domain_risk",
  "churn_signal",
  "noise",
];

export type TaggedEvent =
  | { agent: "cart_abandonment"; timestamp: string; event: CartAbandonmentEvent }
  | { agent: "subscription_recovery"; timestamp: string; event: SubscriptionFailureEvent }
  | { agent: "dispute_responder"; timestamp: string; event: DisputeEvent };

export interface DecisionLike {
  action: string;
  discount_amount: number | null;
  escalate_to_human: boolean;
  reasoning: string;
}

interface DecisionRecord extends DecisionLike {
  agent: AgentType;
  customer_id: string;
  event_id: string;
}

// Event selection for a targeted run.
//
// --limit alone takes the FIRST N events in timestamp order, which are the
// oldest events in the batch — every one of them has an empty asOf profile,
// so a --limit run exercises the pipeline but never a memory signal. The
// customer-granular filters below are what let a small run actually reach
// gaming/churn/dispute-caution behaviour.
//
// --scenario and --customer are customer-granular on purpose. A customer's
// recovery_frequency and dispute counts are read from the raw event tables
// (asOf-scoped, see profile.ts), so those signals are correct no matter which
// events a run processes. discount_usage_history is NOT — it only contains
// discounts this run actually granted — so dropping some of a customer's
// events mid-stream would under-report stoppingRuleHit. Selecting whole
// customers keeps every one of their events in the run, which keeps the
// stopping rule faithful. --limit does not have that property: it can cut a
// customer off partway. Combining --limit with a filter is fine for a smoke
// test, but read stopping-rule counts from a filter-only run.
export interface EventSelection {
  limit?: number;
  scenarios?: Set<Scenario>;
  customers?: Set<string>;
}

function parseListArg(flag: string): string[] | undefined {
  const arg = process.argv.find((a) => a.startsWith(`${flag}=`));
  if (!arg) return undefined;
  const values = arg
    .slice(flag.length + 1)
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  return values.length > 0 ? values : undefined;
}

function parseSelection(): EventSelection {
  const selection: EventSelection = {};

  const limitArg = process.argv.find((a) => a.startsWith("--limit="));
  if (limitArg) {
    const n = Number(limitArg.split("=")[1]);
    if (Number.isFinite(n) && n > 0) selection.limit = n;
  }

  const scenarios = parseListArg("--scenario");
  if (scenarios) {
    const unknown = scenarios.filter((v) => !ALL_SCENARIOS.includes(v as Scenario));
    if (unknown.length > 0) {
      throw new Error(
        `Unknown --scenario value(s): ${unknown.join(", ")}. Valid scenarios: ${ALL_SCENARIOS.join(", ")}`,
      );
    }
    selection.scenarios = new Set(scenarios as Scenario[]);
  }

  const customers = parseListArg("--customer");
  if (customers) selection.customers = new Set(customers);

  return selection;
}

// Scenario labels live alongside the generated batch rather than in the DB —
// they are generator ground truth about how a customer was planted, not an
// observed fact an agent is allowed to read. Loaded only when --scenario is
// actually used, so a plain run never depends on the file being present.
function loadScenarioLabels(): ScenarioLabel[] {
  const path = join(GENERATED_DIR, "scenario_labels.json");
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ScenarioLabel[];
  } catch {
    throw new Error(`--scenario needs ${path}; run \`npm run generate:data\` first.`);
  }
}

function applySelection(tagged: TaggedEvent[], selection: EventSelection): TaggedEvent[] {
  let selected = tagged;

  if (selection.scenarios) {
    const wanted = selection.scenarios;
    const matching = new Set(
      loadScenarioLabels()
        .filter((l) => wanted.has(l.scenario))
        .map((l) => l.customer_id),
    );
    selected = selected.filter((item) => matching.has(item.event.customer_id));
  }

  if (selection.customers) {
    const wanted = selection.customers;
    const found = new Set(selected.map((item) => item.event.customer_id));
    const missing = [...wanted].filter((id) => !found.has(id));
    if (missing.length > 0) {
      console.warn(`  warning: no events for customer(s): ${missing.join(", ")}`);
    }
    selected = selected.filter((item) => wanted.has(item.event.customer_id));
  }

  // Applied last, so --limit trims the already-filtered set rather than
  // competing with it.
  return selection.limit ? selected.slice(0, selection.limit) : selected;
}

// Whole customers run in parallel; --concurrency tunes how many at once.
// Default 12 is a compromise between wall-clock time and API rate limits —
// lower it if the run starts returning 429s.
const DEFAULT_CONCURRENCY = 12;

function parseConcurrency(): number {
  const arg = process.argv.find((a) => a.startsWith("--concurrency="));
  if (!arg) return DEFAULT_CONCURRENCY;
  const n = Number(arg.split("=")[1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_CONCURRENCY;
}

function describeSelection(selection: EventSelection): string {
  const parts: string[] = [];
  if (selection.scenarios) parts.push(`--scenario=${[...selection.scenarios].join(",")}`);
  if (selection.customers) parts.push(`--customer=${[...selection.customers].join(",")}`);
  if (selection.limit) parts.push(`--limit=${selection.limit}`);
  return parts.length > 0 ? ` (${parts.join(" ")})` : "";
}

function loadTaggedEvents(db: Database.Database): { customerById: Map<string, Customer>; tagged: TaggedEvent[] } {
  const customers = db.prepare("SELECT * FROM customers").all() as Customer[];
  const customerById = new Map(customers.map((c) => [c.customer_id, c]));

  const cartEvents = db.prepare("SELECT * FROM cart_abandonment_events").all() as CartAbandonmentEvent[];
  const subEvents = db.prepare("SELECT * FROM subscription_failure_events").all() as SubscriptionFailureEvent[];
  const disputeEvents = db.prepare("SELECT * FROM dispute_events").all() as DisputeEvent[];

  const tagged: TaggedEvent[] = [
    ...cartEvents.map((event): TaggedEvent => ({ agent: "cart_abandonment", timestamp: event.timestamp, event })),
    ...subEvents.map((event): TaggedEvent => ({ agent: "subscription_recovery", timestamp: event.timestamp, event })),
    ...disputeEvents.map(
      (event): TaggedEvent => ({ agent: "dispute_responder", timestamp: event.dispute_created_at, event }),
    ),
  ].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return { customerById, tagged };
}

export interface RunAgentBatchParams {
  mode: "baseline" | "memory";
  outputFile: string;
  decide: (item: TaggedEvent, customer: Customer, db: Database.Database) => Promise<DecisionLike>;
}

export async function runAgentBatch(params: RunAgentBatchParams): Promise<void> {
  const selection = parseSelection();
  const db = openDb();
  const { customerById, tagged } = loadTaggedEvents(db);

  const toProcess = applySelection(tagged, selection);
  const customerCount = new Set(toProcess.map((item) => item.event.customer_id)).size;
  console.log(
    `Running ${params.mode} agents over ${toProcess.length} event(s) across ${customerCount} customer(s)${describeSelection(selection)}...`,
  );
  if (toProcess.length === 0) {
    console.log("Nothing to process — check the selection flags.");
    db.close();
    return;
  }

  // Concurrency is partitioned BY CUSTOMER, and this is the only partition
  // that is safe. A memory-mode decision writes discount_usage/audit_log rows
  // that a LATER event for the SAME customer reads back through the asOf
  // profile, so a customer's events must stay strictly sequential and in
  // timestamp order or the causal chain breaks. Across customers there is no
  // shared state at all — every profile query in profile.ts filters by
  // customer_id — so interleaving whole customers is invisible to the
  // decision logic and produces the same result a fully sequential run would.
  //
  // better-sqlite3 is synchronous: each statement completes before control
  // returns, and these tasks only interleave at await points (the API call),
  // so no two writes can overlap. Baseline mode reads no memory at all and
  // would be safe at any granularity — it uses the same path for simplicity.
  const byCustomer = new Map<string, TaggedEvent[]>();
  for (const item of toProcess) {
    const existing = byCustomer.get(item.event.customer_id);
    if (existing) existing.push(item);
    else byCustomer.set(item.event.customer_id, [item]);
  }
  const queues = [...byCustomer.values()];

  const decisions: DecisionRecord[] = [];
  let completed = 0;
  let nextQueue = 0;

  async function processQueue(queue: TaggedEvent[]): Promise<void> {
    for (const item of queue) {
      const customer = customerById.get(item.event.customer_id);
      if (!customer) continue;

      const decision = await params.decide(item, customer, db);

      appendAuditLog(db, {
        customer_id: customer.customer_id,
        agent: item.agent,
        mode: params.mode,
        action: decision.action,
        reasoning: decision.reasoning,
        metadata: { event_id: item.event.event_id, discount_amount: decision.discount_amount },
        timestamp: item.timestamp,
      });

      if (decision.discount_amount != null) {
        recordDiscountUsage(db, {
          customer_id: customer.customer_id,
          agent: item.agent,
          mode: params.mode,
          amount: decision.discount_amount,
          order_id: "order_id" in item.event ? item.event.order_id : undefined,
          timestamp: item.timestamp,
        });
      }

      decisions.push({
        agent: item.agent,
        customer_id: customer.customer_id,
        event_id: item.event.event_id,
        action: decision.action,
        discount_amount: decision.discount_amount,
        escalate_to_human: decision.escalate_to_human,
        reasoning: decision.reasoning,
      });

      completed += 1;
      if (completed % 25 === 0 || completed === toProcess.length) {
        console.log(`  ${completed}/${toProcess.length}`);
      }
    }
  }

  // Workers pull the next whole customer off a shared cursor, so a customer
  // with 7 events never blocks a worker that could be starting another one.
  async function worker(): Promise<void> {
    while (nextQueue < queues.length) {
      const queue = queues[nextQueue++]!;
      await processQueue(queue);
    }
  }

  const concurrency = Math.min(parseConcurrency(), queues.length);
  console.log(`  concurrency: ${concurrency} customer(s) in flight`);
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // Restore deterministic output ordering. Decisions land in completion order
  // under concurrency, which varies run to run with API latency; the results
  // file and everything downstream of it should not.
  decisions.sort((a, b) => a.event_id.localeCompare(b.event_id));

  db.close();

  mkdirSync(RESULTS_DIR, { recursive: true });
  const outputPath = join(RESULTS_DIR, params.outputFile);
  writeFileSync(outputPath, JSON.stringify(decisions, null, 2) + "\n", "utf-8");

  const actionCounts: Record<string, number> = {};
  let totalDiscount = 0;
  let escalations = 0;
  for (const d of decisions) {
    actionCounts[d.action] = (actionCounts[d.action] ?? 0) + 1;
    if (d.discount_amount) totalDiscount += d.discount_amount;
    if (d.escalate_to_human) escalations++;
  }

  console.log(`Wrote ${decisions.length} decisions to ${outputPath}`);
  console.log(JSON.stringify({ actionCounts, totalDiscountPaise: totalDiscount, escalations }, null, 2));
}
