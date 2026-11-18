// Runs ONLY the agentic cart abandonment agent on a few events.
//
//   npm run agents:agentic -- --scenario=normal --limit=5 [--compare]
//
// --compare also runs the existing baseline and memory arms on the same events,
// so tokens, latency and tool calls can be compared on identical inputs. Each
// arm writes under its own mode. The database must be an isolated copy with
// the current schema, built with:
//   CROSS_AGENT_MEMORY_DB_PATH=data/agentic/agentic.sqlite npm run load:data
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../db/connection.js";
import { CART_ELIGIBLE_SQL } from "../db/eligibility.js";
import type { Customer, CartAbandonmentEvent } from "../types/index.js";
import {
  decideCartAbandonmentBaseline,
  decideCartAbandonmentMemory,
} from "../agents/cartAbandonmentAgent.js";
import { decideCartAbandonmentAgentic } from "./cartAbandonmentAgentic.js";
import { resolveCompareConfig } from "./providerGuard.js";
import { loadScenarioByCustomer, recordArmOutcome } from "./outcomes.js";
import { getLLMProvider } from "../llm/provider.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const COMMITTED = join(ROOT, "data", "db", "cross_agent_memory.sqlite");

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`${name}=`))?.split("=")[1];
}

function die(message: string): never {
  console.error(`agents:agentic: ${message}`);
  process.exit(1);
}

function selectEvents(db: ReturnType<typeof openDb>, scenario: string | undefined, limit: number) {
  const labels = JSON.parse(
    readFileSync(join(ROOT, "data", "generated", "scenario_labels.json"), "utf-8"),
  ) as Array<{ customer_id: string; scenario: string }>;
  const wanted = scenario
    ? new Set(scenario.split(",").map((s) => s.trim()))
    : undefined;
  const customers = new Set(
    labels.filter((l) => !wanted || wanted.has(l.scenario)).map((l) => l.customer_id),
  );
  const rows = db
    .prepare(`SELECT * FROM cart_abandonment_events WHERE ${CART_ELIGIBLE_SQL} ORDER BY created_at, order_id`)
    .all() as CartAbandonmentEvent[];
  return rows.filter((e) => customers.has(e.customer_id)).slice(0, limit);
}

async function main(): Promise<void> {
  const dbPath = process.env.CROSS_AGENT_MEMORY_DB_PATH;
  if (!dbPath) die("CROSS_AGENT_MEMORY_DB_PATH must name an isolated database (see the header of this file).");
  if (resolve(dbPath) === COMMITTED) {
    die("refusing to run against the committed database.");
  }
  const resolved = resolveCompareConfig(process.env);
  if (!resolved.ok) die(resolved.message);
  const config = resolved.config;
  // The baseline and memory arms call the production provider. Check it resolves
  // to the same provider and model as the agentic arm before any event runs.
  const production = getLLMProvider();
  if (production.name !== config.provider || production.model !== config.model) {
    die(
      `production provider resolves to ${production.name}/${production.model}, but the agentic arm uses ` +
        `${config.provider}/${config.model}. Arms must match.`,
    );
  }

  const limit = Number(arg("--limit") ?? "5");
  if (!Number.isSafeInteger(limit) || limit < 1) die("--limit must be a positive integer");
  const compare = process.argv.includes("--compare");

  const db = openDb(dbPath);
  const events = selectEvents(db, arg("--scenario"), limit);
  const scenarios = loadScenarioByCustomer();
  if (events.length === 0) die("no eligible cart events match the selection");

  console.log(`events: ${events.length}, scenario=${arg("--scenario") ?? "all"}, compare=${compare}`);
  console.log(`arm agentic   provider=${config.provider} model=${config.model}`);
  if (compare) {
    console.log(`arm baseline provider=${production.name} model=${production.model}`);
    console.log(`arm memory   provider=${production.name} model=${production.model}`);
  }
  console.log("");

  for (const event of events) {
    const customer = db
      .prepare("SELECT * FROM customers WHERE customer_id = ?")
      .get(event.customer_id) as Customer;
    console.log(`[${event.order_id}] ${event.customer_id} amount=${event.amount} paise`);

    const agentic = await decideCartAbandonmentAgentic(db, customer, event, {
      model: config.model,
      baseUrl: config.baseUrl,
      pricingModel: config.pricingModel,
    });
    console.log(
      `  agentic   ${agentic.status.padEnd(12)} action=${agentic.action} spend=${agentic.committed_spend_paise ?? "null"} ` +
        `escalate=${agentic.escalate_to_human} investigation_calls=${agentic.investigation_calls} ` +
        `model_calls=${agentic.model_calls}${agentic.failure ? ` fallback="${agentic.failure}"` : ""}`,
    );
    // Same as the runner: a decided event records its intervention outcome.
    // Fallbacks do not, because the runner's fallback path does not either.
    if (agentic.status === "decided") {
      recordArmOutcome(db, {
        mode: "agentic",
        customerId: customer.customer_id,
        eventId: event.order_id,
        timestamp: event.created_at,
        grossAmountPaise: event.amount,
        scenario: scenarios.get(customer.customer_id),
        decision: agentic,
      });
    }

    if (compare) {
      const baseline = await decideCartAbandonmentBaseline(db, customer, event);
      recordArmOutcome(db, {
        mode: "baseline",
        customerId: customer.customer_id,
        eventId: event.order_id,
        timestamp: event.created_at,
        grossAmountPaise: event.amount,
        scenario: scenarios.get(customer.customer_id),
        decision: baseline,
      });
      console.log(
        `  baseline  decided      action=${baseline.action} spend=${baseline.committed_spend_paise ?? "null"} escalate=${baseline.escalate_to_human}`,
      );
      const memory = await decideCartAbandonmentMemory(db, customer, event);
      recordArmOutcome(db, {
        mode: "memory",
        customerId: customer.customer_id,
        eventId: event.order_id,
        timestamp: event.created_at,
        grossAmountPaise: event.amount,
        scenario: scenarios.get(customer.customer_id),
        decision: memory,
      });
      console.log(
        `  memory    decided      action=${memory.action} spend=${memory.committed_spend_paise ?? "null"} escalate=${memory.escalate_to_human}`,
      );
    }
    console.log("");
  }

  db.close();
}

main().catch((err) => {
  console.error(`agents:agentic FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
