import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { createLLMValidationHandoff } from "../src/agents/llmValidationHandoff.js";
import { CartAbandonmentDecisionSchema } from "../src/agents/schema.js";
import { LLMResponseValidationError, LLMNonRetryableError } from "../src/llm/errors.js";
import { GeminiProvider, GeminiRequestLimiter, zodToGeminiJsonSchema } from "../src/llm/geminiProvider.js";
import { instrumentProvider } from "../src/llm/instrumentedProvider.js";

const SCHEMA_PATH = join(import.meta.dirname, "..", "src", "db", "schema.sql");
const validDecision = {
  reasoning: "A reminder is a suitable low-cost next step for this abandoned order.",
  memory_factors_used: [],
  action: "send_reminder",
  committed_spend_paise: null,
  escalate_to_human: false,
  escalation_reason: null,
};

function providerWithResponses(
  responses: Array<{ text?: string; usageMetadata?: Record<string, number> } | Error>,
  options: { maxCallsPerRun?: number; sleep?: (milliseconds: number) => Promise<void> } = {},
) {
  let requests = 0;
  const provider = new GeminiProvider({
    model: "test-flash",
    requestsPerMinute: 60,
    maxCallsPerRun: options.maxCallsPerRun ?? 10,
    sleep: options.sleep,
    client: {
      models: {
        async generateContent() {
          const response = responses[requests++];
          if (!response) throw new Error("Unexpected extra Gemini request");
          if (response instanceof Error) throw response;
          return response;
        },
      },
    },
  });
  return { provider, requestCount: () => requests };
}

test("Zod nullable fields are converted to Gemini JSON Schema and validated after response", async () => {
  const schema = zodToGeminiJsonSchema(CartAbandonmentDecisionSchema) as {
    properties: Record<string, { nullable?: boolean }>;
  };
  assert.equal(schema.properties.committed_spend_paise?.nullable, true);
  assert.equal(schema.properties.escalation_reason?.nullable, true);

  const { provider } = providerWithResponses([
    {
      text: JSON.stringify(validDecision),
      usageMetadata: {
        promptTokenCount: 100,
        cachedContentTokenCount: 20,
        candidatesTokenCount: 25,
        thoughtsTokenCount: 3,
      },
    },
  ]);
  const result = await provider.generateStructured(
    "system",
    "user",
    CartAbandonmentDecisionSchema,
  );
  assert.deepEqual(result.parsed, validDecision);
  assert.equal(result.usage.inputTokens, 80);
  assert.equal(result.usage.cachedTokens, 20);
  assert.equal(result.usage.outputTokens, 28);
  assert.equal(result.usage.model, "test-flash");
});

test("invalid structured output is retried once then raised as non-retryable", async () => {
  const malformed = JSON.stringify({ ...validDecision, action: "unsupported" });
  const { provider, requestCount } = providerWithResponses([{ text: malformed }, { text: malformed }]);
  await assert.rejects(
    provider.generateStructured("system", "user", CartAbandonmentDecisionSchema),
    LLMResponseValidationError,
  );
  assert.equal(requestCount(), 2);
});

test("429 retries use bounded exponential backoff; quota errors stop immediately", async () => {
  const delays: number[] = [];
  const rateLimitError = Object.assign(new Error("Too many requests"), { status: 429 });
  const { provider, requestCount } = providerWithResponses(
    [rateLimitError, rateLimitError, { text: JSON.stringify(validDecision) }],
    { sleep: async (milliseconds) => void delays.push(milliseconds) },
  );
  await provider.generateStructured("system", "user", CartAbandonmentDecisionSchema);
  assert.deepEqual(delays, [500, 1000]);
  assert.equal(requestCount(), 3);

  const quota = Object.assign(new Error("Quota exceeded for today"), { status: 429 });
  const quotaProvider = providerWithResponses([quota]);
  await assert.rejects(
    quotaProvider.provider.generateStructured("system", "user", CartAbandonmentDecisionSchema),
    LLMNonRetryableError,
  );
  assert.equal(quotaProvider.requestCount(), 1);
});

test("per-run call cap prevents any additional Gemini request", async () => {
  const { provider, requestCount } = providerWithResponses(
    [{ text: JSON.stringify(validDecision) }],
    { maxCallsPerRun: 1 },
  );
  await provider.generateStructured("system", "user", CartAbandonmentDecisionSchema);
  await assert.rejects(
    provider.generateStructured("system", "user", CartAbandonmentDecisionSchema),
    /MAX_LLM_CALLS_PER_RUN=1/,
  );
  assert.equal(requestCount(), 1);
});

test("exhausted validation failures become no-spend human-review decisions per agent", () => {
  const error = new LLMResponseValidationError("invalid response");
  for (const [agent, expectedAction] of [
    ["cart_abandonment", "send_reminder"],
    ["subscription_recovery", "retry_payment"],
    ["dispute_responder", "contest_dispute"],
  ] as const) {
    const decision = createLLMValidationHandoff(agent, error);
    assert.equal(decision.action, expectedAction);
    assert.equal(decision.committed_spend_paise, null);
    assert.equal(decision.escalate_to_human, true);
    assert.equal(decision.escalation_reason, "policy_constraint");
    assert.deepEqual(decision.policy_override?.triggered_by, ["llm_response_validation_failed"]);
  }
});

test("RPM limiter serializes concurrent request turns at the configured interval", async () => {
  let now = 0;
  const delays: number[] = [];
  const limiter = new GeminiRequestLimiter(5, {
    now: () => now,
    sleep: async (milliseconds) => {
      delays.push(milliseconds);
      now += milliseconds;
    },
  });
  await Promise.all([limiter.waitTurn(), limiter.waitTurn(), limiter.waitTurn()]);
  assert.deepEqual(delays, [12_000, 12_000]);
});

test("instrumentation writes one metrics row for every Gemini request attempt", async () => {
  const db = new Database(":memory:");
  db.exec(readFileSync(SCHEMA_PATH, "utf-8"));
  db.prepare(
    `INSERT INTO customers (customer_id, name, email, contact, signup_date, plan_tier)
     VALUES ('cust_gemini', 'Gemini', 'gemini@example.com', '+910000000000', '2026-01-01', 'basic')`,
  ).run();
  const malformed = JSON.stringify({ ...validDecision, action: "unsupported" });
  const { provider } = providerWithResponses([
    {
      text: malformed,
      usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 20 },
    },
    {
      text: JSON.stringify(validDecision),
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 25 },
    },
  ]);
  const instrumented = instrumentProvider(provider);
  await instrumented.generateStructured("system", "user", CartAbandonmentDecisionSchema, {
    db,
    customerId: "cust_gemini",
    eventId: "order_gemini",
    agent: "cart_abandonment",
    mode: "baseline",
    stepType: "decision",
  });
  const rows = db
    .prepare("SELECT status, input_tokens, output_tokens FROM llm_call_metrics ORDER BY rowid")
    .all() as { status: string; input_tokens: number; output_tokens: number }[];
  assert.deepEqual(rows, [
    { status: "error", input_tokens: 90, output_tokens: 20 },
    { status: "success", input_tokens: 100, output_tokens: 25 },
  ]);
  db.close();
});
