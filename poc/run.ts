// Proof of concept: one LangGraph.js agent with one read-only tool, running on a
// local Ollama model. Each model call is recorded to llm_call_metrics.
//
// Usage: npm run poc:agent [customer_id]
// Database: data/poc/poc.sqlite, a copy of the committed database. Created on
// first run if missing. The committed file is never opened for writing.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChatOllama } from "@langchain/ollama";
import { HumanMessage } from "@langchain/core/messages";
import { openDb } from "../src/db/connection.js";
import { buildAgent } from "./agent.js";
import { MetricsCallback } from "./metricsCallback.js";
import { makeFailedPaymentTool, openReadOnly } from "./tools.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMMITTED = join(ROOT, "data", "db", "cross_agent_memory.sqlite");
const POC_DB = process.env.CROSS_AGENT_MEMORY_DB_PATH ?? join(ROOT, "data", "poc", "poc.sqlite");
const MODEL = process.env.OLLAMA_MODEL?.trim() || "qwen2.5:7b";

function ensurePocDatabase(): void {
  if (existsSync(POC_DB)) return;
  mkdirSync(dirname(POC_DB), { recursive: true });
  copyFileSync(COMMITTED, POC_DB);
}

async function main(): Promise<void> {
  if (POC_DB === COMMITTED) throw new Error("refusing to run the PoC against the committed database");
  ensurePocDatabase();
  // openDb() adds any missing tables (llm_call_metrics) to the PoC copy only.
  openDb(POC_DB).close();

  const readDb = openReadOnly(POC_DB);
  const writeDb = openDb(POC_DB);

  const customerArg = process.argv[2];
  const customerId =
    customerArg ??
    (readDb
      .prepare(
        `SELECT customer_id FROM subscription_failure_events
         WHERE status = 'failed' GROUP BY customer_id ORDER BY COUNT(*) DESC, customer_id LIMIT 1`,
      )
      .get() as { customer_id: string } | undefined)?.customer_id;
  if (!customerId) throw new Error("no customer with failed subscription payments in the PoC database");

  const model = new ChatOllama({
    model: MODEL,
    baseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
    temperature: 0,
    numPredict: 1024,
  });
  const agent = buildAgent(model, [makeFailedPaymentTool(readDb)]);

  const eventId = `poc_${customerId}_${Date.now()}`;
  const metrics = new MetricsCallback({
    db: writeDb,
    customerId,
    eventId,
    agent: "poc_failed_payments",
    model: MODEL,
    pricingModel: process.env.OLLAMA_PRICING_MODEL?.trim() || undefined,
  });

  const question =
    `Customer ${customerId} has a failed subscription payment. Use the count_failed_payments tool ` +
    `to check their failed payment history, then answer in at most two sentences: the count, and ` +
    `whether a plain retry looks reasonable.`;

  const result = await agent.invoke(
    { messages: [new HumanMessage(question)] },
    { callbacks: [metrics], recursionLimit: 10 },
  );

  console.log(`model: ${MODEL}   customer: ${customerId}   database: ${POC_DB}\n`);
  for (const message of result.messages) {
    const calls = (message as { tool_calls?: Array<{ name: string; args: unknown }> }).tool_calls ?? [];
    for (const call of calls) console.log(`tool call: ${call.name}(${JSON.stringify(call.args)})`);
    if (message.getType() === "tool") console.log(`tool result: ${String(message.content)}`);
  }
  const answer = result.messages.at(-1);
  console.log(`\nanswer: ${String(answer?.content ?? "")}`);

  readDb.close();
  writeDb.close();
}

main().catch((err) => {
  console.error(`poc:agent FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
