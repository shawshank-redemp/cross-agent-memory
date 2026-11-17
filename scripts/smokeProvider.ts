// One real LLM call per agent type, against an isolated database.
// Usage: tsx scripts/smokeProvider.ts <gemini|ollama>
//
// Runs the production BASELINE decide functions (the same code path the
// baseline arm uses) on one eligible event per agent, then checks that the
// llm_call_metrics rows were written and that every one was served by Gemini.
//
// Refuses to run unless LLM_PROVIDER matches the argument. The Anthropic provider is never
// constructed here, so no Anthropic API call can be made by this script.
//
// Run via `npm run smoke:gemini` or `npm run smoke:ollama`, which set
// CROSS_AGENT_MEMORY_DB_PATH to an isolated file under data/smoke/.

const SUPPORTED = ["gemini", "ollama"] as const;
type SmokeProvider = (typeof SUPPORTED)[number];
const provider = process.argv[2] as SmokeProvider;
if (!SUPPORTED.includes(provider)) {
  console.error(`usage: smokeProvider.ts <${SUPPORTED.join("|")}>`);
  process.exit(1);
}

// Each provider's rows must come from that provider. Gemini models are named
// gemini-*; Ollama runs whatever OLLAMA_MODEL names, so it is checked exactly.
function rowIsFromProvider(model: string): boolean {
  if (provider === "gemini") return model.startsWith("gemini");
  return model === process.env.OLLAMA_MODEL?.trim();
}

import type Database from "better-sqlite3";
import { dbExistsAt, openDb } from "../src/db/connection.js";
import {
  CART_ELIGIBLE_SQL,
  DISPUTE_ELIGIBLE_SQL,
  SUBSCRIPTION_ELIGIBLE_SQL,
} from "../src/db/eligibility.js";
import { decideCartAbandonmentBaseline } from "../src/agents/cartAbandonmentAgent.js";
import { decideSubscriptionRecoveryBaseline } from "../src/agents/subscriptionRecoveryAgent.js";
import { decideDisputeResponderBaseline } from "../src/agents/disputeResponderAgent.js";
import type {
  CartAbandonmentEvent,
  Customer,
  DisputeEvent,
  SubscriptionFailureEvent,
} from "../src/types/index.js";

interface MetricRow {
  model: string;
  status: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  latency_ms: number;
  cost_usd: number | null;
}

function fail(message: string): never {
  console.error(`smoke:${provider} FAILED: ${message}`);
  process.exit(1);
}

// Only rows written by THIS run (rowid above the high-water mark taken before
// the calls). The isolated DB accumulates across runs, and an earlier run's rows
// for the same event must not be judged as if this run wrote them.
function metricsFor(db: Database.Database, eventId: string, sinceRowId: number): MetricRow[] {
  return db
    .prepare(
      `SELECT model, status, input_tokens, output_tokens, cached_tokens, latency_ms, cost_usd
       FROM llm_call_metrics WHERE event_id = ? AND rowid > ? ORDER BY rowid`,
    )
    .all(eventId, sinceRowId) as MetricRow[];
}

function customerFor(db: Database.Database, customerId: string): Customer {
  const row = db.prepare("SELECT * FROM customers WHERE customer_id = ?").get(customerId);
  if (!row) fail(`no customer row for ${customerId}`);
  return row as Customer;
}

function printDecision(agent: string, eventId: string, decision: {
  action: string;
  committed_spend_paise: number | null;
  escalate_to_human: boolean;
  reasoning: string;
}): void {
  const reasoning = decision.reasoning.replace(/\s+/g, " ").slice(0, 240);
  console.log(`\n[${agent}] event ${eventId}`);
  console.log(`  action            ${decision.action}`);
  console.log(`  committed_spend   ${decision.committed_spend_paise ?? "null"} paise`);
  console.log(`  escalate_to_human ${decision.escalate_to_human}`);
  console.log(`  reasoning         ${reasoning}${decision.reasoning.length > 240 ? "..." : ""}`);
}

async function main(): Promise<void> {
  if (process.env.LLM_PROVIDER !== provider) {
    fail(`LLM_PROVIDER must be "${provider}" (got "${process.env.LLM_PROVIDER ?? "unset"}"). Use npm run smoke:${provider}.`);
  }
  if (provider === "ollama" && !process.env.OLLAMA_MODEL?.trim()) {
    fail("OLLAMA_MODEL must be set (e.g. OLLAMA_MODEL=qwen2.5:1.5b).");
  }
  const dbPath = process.env.CROSS_AGENT_MEMORY_DB_PATH;
  if (!dbPath) fail("CROSS_AGENT_MEMORY_DB_PATH is not set; the smoke test must use an isolated database.");
  if (!dbExistsAt(dbPath)) {
    fail(`no database at ${dbPath}. Build it first: CROSS_AGENT_MEMORY_DB_PATH=${dbPath} npm run load:data`);
  }

  const db = openDb();
  console.log(`Isolated database: ${dbPath}`);
  const modelLabel =
    provider === "gemini"
      ? process.env.GEMINI_MODEL?.trim() || "(default in geminiProvider.ts)"
      : process.env.OLLAMA_MODEL?.trim();
  console.log(`Provider: ${provider}, model: ${modelLabel}`);

  const cart = db
    .prepare(`SELECT * FROM cart_abandonment_events WHERE ${CART_ELIGIBLE_SQL} ORDER BY created_at LIMIT 1`)
    .get() as CartAbandonmentEvent | undefined;
  const subscription = db
    .prepare(`SELECT * FROM subscription_failure_events WHERE ${SUBSCRIPTION_ELIGIBLE_SQL} ORDER BY created_at LIMIT 1`)
    .get() as SubscriptionFailureEvent | undefined;
  const dispute = db
    .prepare(`SELECT * FROM dispute_events WHERE ${DISPUTE_ELIGIBLE_SQL} ORDER BY dispute_created_at LIMIT 1`)
    .get() as DisputeEvent | undefined;
  if (!cart || !subscription || !dispute) {
    fail("the database has no eligible event for one of the agents; rebuild it with load:data");
  }

  const cases: Array<{
    agent: string;
    eventId: string;
    run: () => Promise<{ action: string; committed_spend_paise: number | null; escalate_to_human: boolean; reasoning: string }>;
  }> = [
    {
      agent: "cart_abandonment",
      eventId: cart.order_id,
      run: () => decideCartAbandonmentBaseline(db, customerFor(db, cart.customer_id), cart),
    },
    {
      agent: "subscription_recovery",
      eventId: subscription.payment_id,
      run: () => decideSubscriptionRecoveryBaseline(db, customerFor(db, subscription.customer_id), subscription),
    },
    {
      agent: "dispute_responder",
      eventId: dispute.dispute_id,
      run: () => decideDisputeResponderBaseline(db, customerFor(db, dispute.customer_id), dispute),
    },
  ];

  const highWaterBefore = (db.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM llm_call_metrics").get() as { m: number }).m;
  const rowsBefore = (db.prepare("SELECT COUNT(*) AS n FROM llm_call_metrics").get() as { n: number }).n;
  let usageSummary = "";

  for (const testCase of cases) {
    let decision;
    try {
      decision = await testCase.run();
    } catch (err) {
      db.close();
      fail(`${testCase.agent} call failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    printDecision(testCase.agent, testCase.eventId, decision);
    const rows = metricsFor(db, testCase.eventId, highWaterBefore);
    if (rows.length === 0) fail(`no llm_call_metrics row for ${testCase.agent} ${testCase.eventId}`);
    for (const row of rows) {
      if (!rowIsFromProvider(row.model)) {
        fail(`metrics row for ${testCase.agent} has model "${row.model}", not from ${provider}`);
      }
      usageSummary +=
        `  ${testCase.agent.padEnd(22)} status=${row.status} in=${row.input_tokens} ` +
        `out=${row.output_tokens} cached=${row.cached_tokens} latency=${row.latency_ms}ms ` +
        `notional_cost=${row.cost_usd === null ? "null" : `$${row.cost_usd.toFixed(6)}`}\n`;
    }
  }

  const rowsAfter = (db.prepare("SELECT COUNT(*) AS n FROM llm_call_metrics").get() as { n: number }).n;
  console.log("\nUsage (free-tier actual cost is $0; cost_usd is NOTIONAL paid-tier):");
  process.stdout.write(usageSummary);
  console.log(`\nllm_call_metrics rows written this run: ${rowsAfter - rowsBefore}`);
  db.close();
  console.log(`smoke:${provider} PASSED: 3 agent decisions, metrics rows present for each, all served by ${provider}.`);
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
