import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CartAbandonmentDecisionSchema,
  DisputeResponderDecisionSchema,
  SubscriptionRecoveryDecisionSchema,
} from "../src/agents/schema.js";
import { computeCost } from "../src/llm/pricing.js";
import { getLLMProvider } from "../src/llm/provider.js";

test("mock provider returns deterministic valid decisions for each agent schema", async () => {
  const originalProvider = process.env.LLM_PROVIDER;
  process.env.LLM_PROVIDER = "mock";
  try {
    const provider = getLLMProvider();
    assert.equal(provider.name, "mock");
    assert.equal(provider.model, "mock-decision-v1");
    assert.equal(provider.generateStructuredBatch, undefined);

    for (const [schema, expectedAction] of [
      [CartAbandonmentDecisionSchema, "send_reminder"],
      [SubscriptionRecoveryDecisionSchema, "retry_payment"],
      [DisputeResponderDecisionSchema, "contest_dispute"],
    ] as const) {
      const first = await provider.generateStructured("system prompt", "event payload", schema);
      const second = await provider.generateStructured("system prompt", "event payload", schema);
      assert.deepEqual(first.parsed, second.parsed);
      assert.equal(first.parsed.action, expectedAction);
      assert.ok(first.usage.inputTokens > 0);
      assert.ok(first.usage.outputTokens > 0);
      assert.ok(first.usage.latencyMs > 0);
      assert.equal(first.usage.model, "mock-decision-v1");
    }
  } finally {
    if (originalProvider === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = originalProvider;
  }
});

test("LLM pricing accounts for cache read/write rates and batch discount", () => {
  assert.equal(
    computeCost(
      {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cachedTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      },
      "claude-opus-5",
    ),
    36.75,
  );
  assert.equal(
    computeCost({ inputTokens: 1_000_000, outputTokens: 0, batchDiscount: 0.5 }, "claude-opus-5"),
    2.5,
  );
  assert.equal(computeCost({ inputTokens: 10, outputTokens: 10 }, "unpriced-model"), null);
  assert.equal(
    computeCost(
      { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedTokens: 1_000_000 },
      "gemini-3.8-flash",
    ),
    4.575,
  );
});
