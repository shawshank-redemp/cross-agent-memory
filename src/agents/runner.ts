import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { openDb } from "../db/connection.js";
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

function parseLimitArg(): number | undefined {
  const arg = process.argv.find((a) => a.startsWith("--limit="));
  if (!arg) return undefined;
  const n = Number(arg.split("=")[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
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
  const limit = parseLimitArg();
  const db = openDb();
  const { customerById, tagged } = loadTaggedEvents(db);

  const toProcess = limit ? tagged.slice(0, limit) : tagged;
  console.log(`Running ${params.mode} agents over ${toProcess.length} event(s)${limit ? ` (--limit=${limit})` : ""}...`);

  const decisions: DecisionRecord[] = [];

  for (const [i, item] of toProcess.entries()) {
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

    if ((i + 1) % 25 === 0 || i + 1 === toProcess.length) {
      console.log(`  ${i + 1}/${toProcess.length}`);
    }
  }

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
