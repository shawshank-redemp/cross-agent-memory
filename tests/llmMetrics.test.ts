import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { z } from "zod";
import { instrumentProvider } from "../src/llm/instrumentedProvider.js";
import type { LLMProvider } from "../src/llm/provider.js";

const SCHEMA_PATH = join(import.meta.dirname, "..", "src", "db", "schema.sql");

test("instrumented provider records structured-call metrics and trace identifiers", async () => {
  const db = new Database(":memory:");
  db.exec(readFileSync(SCHEMA_PATH, "utf-8"));
  db.prepare(
    `INSERT INTO customers (customer_id, name, email, contact, signup_date, plan_tier)
     VALUES ('cust_metrics', 'Metrics', 'metrics@example.com', '+910000000000', '2026-01-01', 'basic')`,
  ).run();

  const schema = z.object({ answer: z.string() });
  const provider: LLMProvider = {
    name: "test",
    model: "mock-decision-v1",
    async generateStructured<Schema extends z.ZodType>(
      _system: string,
      _userContent: string,
      responseSchema: Schema,
    ) {
      return {
        parsed: responseSchema.parse({ answer: "valid structured response" }),
        usage: {
          inputTokens: 120,
          outputTokens: 30,
          cachedTokens: 10,
          cacheWriteTokens: 5,
          latencyMs: 750,
          model: "mock-decision-v1",
        },
      };
    },
  };
  const instrumented = instrumentProvider(provider);
  const result = await instrumented.generateStructured("system", "user", schema, {
    db,
    customerId: "cust_metrics",
    eventId: "order_metrics",
    agent: "cart_abandonment",
    mode: "memory",
    stepType: "decision",
  });

  assert.deepEqual(result.parsed, { answer: "valid structured response" });
  const row = db
    .prepare("SELECT * FROM llm_call_metrics WHERE event_id = ?")
    .get("order_metrics") as {
    trace_id: string;
    span_id: string;
    parent_span_id: string | null;
    agent: string;
    mode: string;
    step_type: string;
    input_tokens: number;
    output_tokens: number;
    cached_tokens: number;
    cache_write_tokens: number;
    latency_ms: number;
    tokens_per_second: number;
    cost_usd: number | null;
    status: string;
  };
  assert.ok(row.trace_id);
  assert.ok(row.span_id);
  assert.equal(row.parent_span_id, null);
  assert.equal(row.agent, "cart_abandonment");
  assert.equal(row.mode, "memory");
  assert.equal(row.step_type, "decision");
  assert.equal(row.input_tokens, 120);
  assert.equal(row.output_tokens, 30);
  assert.equal(row.cached_tokens, 10);
  assert.equal(row.cache_write_tokens, 5);
  assert.equal(row.latency_ms, 750);
  assert.equal(row.tokens_per_second, 40);
  assert.equal(row.cost_usd, 0);
  assert.equal(row.status, "success");
  db.close();
});
