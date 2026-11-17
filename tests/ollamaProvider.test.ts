import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { CartAbandonmentDecisionSchema } from "../src/agents/schema.js";
import { LLMNonRetryableError, LLMResponseValidationError } from "../src/llm/errors.js";
import { instrumentProvider } from "../src/llm/instrumentedProvider.js";
import { OllamaProvider, usageFromOllama, type FetchLike } from "../src/llm/ollamaProvider.js";
import { computeCost } from "../src/llm/pricing.js";

const SCHEMA_PATH = join(import.meta.dirname, "..", "src", "db", "schema.sql");
const validDecision = {
  reasoning: "A reminder is a suitable low-cost next step for this abandoned order.",
  memory_factors_used: [],
  action: "send_reminder",
  committed_spend_paise: null,
  escalate_to_human: false,
  escalation_reason: null,
};

function okResponse(content: string, counts: Record<string, number> = {}): Response {
  return new Response(
    JSON.stringify({
      message: { role: "assistant", content },
      done: true,
      prompt_eval_count: 120,
      eval_count: 40,
      prompt_eval_duration: 300_000_000,
      eval_duration: 900_000_000,
      total_duration: 1_250_000_000,
      ...counts,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function providerWith(
  fetch: FetchLike,
  options: { maxCallsPerRun?: number; pricingModel?: string } = {},
): { provider: OllamaProvider; bodies: Array<Record<string, unknown>> } {
  const bodies: Array<Record<string, unknown>> = [];
  const wrapped: FetchLike = (url, init) => {
    bodies.push(JSON.parse(String(init.body)));
    return fetch(url, init);
  };
  const provider = new OllamaProvider({
    model: "qwen-test",
    baseUrl: "http://ollama.test:11434/",
    maxCallsPerRun: options.maxCallsPerRun ?? 10,
    pricingModel: options.pricingModel,
    fetch: wrapped,
  });
  return { provider, bodies };
}

test("requests go to /api/chat with a JSON Schema in format and deterministic options", async () => {
  const { provider, bodies } = providerWith(async () => okResponse(JSON.stringify(validDecision)));
  await provider.generateStructured("system text", "user text", CartAbandonmentDecisionSchema);
  const body = bodies[0] as {
    model: string;
    stream: boolean;
    format: { type: string; properties: Record<string, unknown> };
    options: { temperature: number };
    messages: Array<{ role: string; content: string }>;
  };
  assert.equal(body.model, "qwen-test");
  assert.equal(body.stream, false);
  assert.equal(body.options.temperature, 0);
  assert.equal(body.format.type, "object");
  assert.ok("action" in body.format.properties, "format should carry the decision schema");
  assert.deepEqual(body.messages.map((m) => m.role), ["system", "user"]);
});

test("usage maps Ollama counts and nanosecond durations into the shared shape", async () => {
  const { provider } = providerWith(async () => okResponse(JSON.stringify(validDecision)));
  const result = await provider.generateStructured("s", "u", CartAbandonmentDecisionSchema);
  assert.equal(result.usage.inputTokens, 120);
  assert.equal(result.usage.outputTokens, 40);
  assert.equal(result.usage.cachedTokens, 0);
  assert.equal(result.usage.model, "qwen-test");
  assert.equal(typeof result.usage.latencyMs, "number");

  const mapped = usageFromOllama(
    { prompt_eval_count: 7, eval_count: 3, total_duration: 2_000_000_000 },
    "m",
    2000,
    "gemini-3.8-flash",
  );
  assert.deepEqual(mapped, {
    inputTokens: 7,
    outputTokens: 3,
    cachedTokens: 0,
    latencyMs: 2000,
    model: "m",
    pricingModel: "gemini-3.8-flash",
  });
});

test("invalid structured output is retried once, then raised as a non-retryable validation error", async () => {
  const malformed = JSON.stringify({ ...validDecision, action: "unsupported" });
  let calls = 0;
  const { provider } = providerWith(async () => {
    calls += 1;
    return okResponse(malformed);
  });
  await assert.rejects(
    provider.generateStructured("s", "u", CartAbandonmentDecisionSchema),
    LLMResponseValidationError,
  );
  assert.equal(calls, 2);
});

test("a second attempt that validates is returned, after one retry", async () => {
  const malformed = JSON.stringify({ ...validDecision, action: "unsupported" });
  const responses = [okResponse(malformed), okResponse(JSON.stringify(validDecision))];
  const { provider } = providerWith(async () => responses.shift()!);
  const result = await provider.generateStructured("s", "u", CartAbandonmentDecisionSchema);
  assert.equal(result.parsed.action, "send_reminder");
});

test("a server that is not running fails immediately with a pointer to ollama serve", async () => {
  let calls = 0;
  const { provider } = providerWith(async () => {
    calls += 1;
    throw new TypeError("fetch failed: ECONNREFUSED");
  });
  await assert.rejects(
    provider.generateStructured("s", "u", CartAbandonmentDecisionSchema),
    (error: unknown) =>
      error instanceof LLMNonRetryableError && /ollama serve/.test(String(error.message)),
  );
  assert.equal(calls, 1, "connection refused must not be retried");
});

test("an HTTP error (for example, model not pulled) is non-retryable and names the status", async () => {
  const { provider } = providerWith(
    async () => new Response("model 'qwen-test' not found", { status: 404 }),
  );
  await assert.rejects(
    provider.generateStructured("s", "u", CartAbandonmentDecisionSchema),
    (error: unknown) => error instanceof LLMNonRetryableError && /HTTP 404/.test(String(error.message)),
  );
});

test("the per-run call cap stops further requests", async () => {
  const { provider } = providerWith(async () => okResponse(JSON.stringify(validDecision)), {
    maxCallsPerRun: 1,
  });
  await provider.generateStructured("s", "u", CartAbandonmentDecisionSchema);
  await assert.rejects(
    provider.generateStructured("s", "u", CartAbandonmentDecisionSchema),
    /MAX_LLM_CALLS_PER_RUN=1/,
  );
});

test("a missing OLLAMA_MODEL is an explicit error, not a silent default", () => {
  const saved = process.env.OLLAMA_MODEL;
  delete process.env.OLLAMA_MODEL;
  try {
    assert.throws(() => new OllamaProvider({ fetch: async () => okResponse("{}") }), /OLLAMA_MODEL is required/);
  } finally {
    if (saved !== undefined) process.env.OLLAMA_MODEL = saved;
  }
});

test("notional cost uses the configured pricing model; unset means no cost, never a guess", () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, latencyMs: 1, model: "qwen-test" };
  assert.equal(computeCost(usage, "gemini-3.8-flash"), 0.75 + 3.75);
  assert.equal(computeCost(usage, "qwen-test"), null);
});

test("instrumentation records the local model name and prices it against the pricing model", async () => {
  const db = new Database(":memory:");
  db.exec(readFileSync(SCHEMA_PATH, "utf-8"));
  db.prepare(
    `INSERT INTO customers (customer_id, name, email, contact, signup_date, plan_tier)
     VALUES ('cust_ollama', 'Ollama', 'ollama@example.com', '+910000000000', '2026-01-01', 'basic')`,
  ).run();
  const { provider } = providerWith(async () => okResponse(JSON.stringify(validDecision)), {
    pricingModel: "gemini-3.8-flash",
  });
  const instrumented = instrumentProvider(provider);
  await instrumented.generateStructured("s", "u", CartAbandonmentDecisionSchema, {
    db,
    customerId: "cust_ollama",
    eventId: "order_ollama",
    agent: "cart_abandonment",
    mode: "baseline",
    stepType: "decision",
  });
  const row = db
    .prepare("SELECT model, cost_usd, status FROM llm_call_metrics WHERE event_id = 'order_ollama'")
    .get() as { model: string; cost_usd: number; status: string };
  assert.equal(row.model, "qwen-test");
  assert.equal(row.status, "success");
  // 120 input + 40 output tokens at gemini-3.8-flash notional rates.
  assert.equal(row.cost_usd, (120 * 0.75 + 40 * 3.75) / 1_000_000);
  db.close();
});
