import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { CartAbandonmentDecisionSchema } from "../src/agents/schema.js";
import { GeminiProvider } from "../src/llm/geminiProvider.js";
import { instrumentProvider } from "../src/llm/instrumentedProvider.js";
import { OllamaProvider } from "../src/llm/ollamaProvider.js";
import type { LLMCallContext, LLMProvider } from "../src/llm/provider.js";

const SCHEMA_PATH = join(import.meta.dirname, "..", "src", "db", "schema.sql");

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(readFileSync(SCHEMA_PATH, "utf-8"));
  db.prepare(
    `INSERT INTO customers (customer_id, name, email, contact, signup_date, plan_tier)
     VALUES ('cust_label', 'Label', 'label@example.com', '+910000000000', '2026-01-01', 'basic')`,
  ).run();
  return db;
}

function contextFor(db: Database.Database, eventId: string): LLMCallContext {
  return {
    db,
    customerId: "cust_label",
    eventId,
    agent: "cart_abandonment",
    mode: "baseline",
    stepType: "decision",
  };
}

function modelsRecorded(db: Database.Database): string[] {
  return (db.prepare("SELECT model FROM llm_call_metrics ORDER BY rowid").all() as { model: string }[]).map(
    (row) => row.model,
  );
}

// A call that dies before any usage is returned. This is the case that used to
// record "unknown": timeouts, 429/503 responses, refused connections.
function failingFake(model: string): LLMProvider {
  return {
    name: "fake",
    model,
    async generateStructured() {
      throw new Error("upstream unavailable");
    },
  };
}

test("a provider call that fails before any usage is labelled with the provider's model", async () => {
  const db = freshDb();
  const instrumented = instrumentProvider(failingFake("fake-model-7b"));
  await assert.rejects(
    instrumented.generateStructured("s", "u", CartAbandonmentDecisionSchema, contextFor(db, "order_fake")),
  );
  assert.deepEqual(modelsRecorded(db), ["fake-model-7b"]);
  db.close();
});

test("Ollama: a refused connection is recorded with the Ollama model name, not unknown", async () => {
  const db = freshDb();
  const provider = new OllamaProvider({
    model: "qwen2.5:7b",
    baseUrl: "http://127.0.0.1:1",
    maxCallsPerRun: 10,
    fetch: async () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    },
  });
  await assert.rejects(
    instrumentProvider(provider).generateStructured("s", "u", CartAbandonmentDecisionSchema, contextFor(db, "order_ollama_down")),
  );
  assert.deepEqual(modelsRecorded(db), ["qwen2.5:7b"]);
  db.close();
});

test("Gemini: a 503 with no usage is recorded with the Gemini model name, not unknown", async () => {
  const db = freshDb();
  const provider = new GeminiProvider({
    model: "gemini-3.8-flash",
    requestsPerMinute: 600,
    maxCallsPerRun: 10,
    client: {
      models: {
        async generateContent() {
          throw Object.assign(new Error("This model is currently experiencing high demand."), { status: 503 });
        },
      },
    },
  });
  await assert.rejects(
    instrumentProvider(provider).generateStructured("s", "u", CartAbandonmentDecisionSchema, contextFor(db, "order_gemini_503")),
  );
  assert.deepEqual(modelsRecorded(db), ["gemini-3.8-flash"]);
  db.close();
});

test("no recorded metrics row, from any provider, is ever labelled unknown", async () => {
  const db = freshDb();
  await assert.rejects(
    instrumentProvider(failingFake("fake-model")).generateStructured("s", "u", CartAbandonmentDecisionSchema, contextFor(db, "e1")),
  );
  await assert.rejects(
    instrumentProvider(
      new OllamaProvider({
        model: "qwen2.5:7b",
        maxCallsPerRun: 10,
        fetch: async () => {
          throw new TypeError("fetch failed");
        },
      }),
    ).generateStructured("s", "u", CartAbandonmentDecisionSchema, contextFor(db, "e2")),
  );
  const unknown = db.prepare("SELECT COUNT(*) AS n FROM llm_call_metrics WHERE model = 'unknown'").get() as { n: number };
  assert.equal(unknown.n, 0);
  assert.equal(modelsRecorded(db).length, 2);
  db.close();
});
