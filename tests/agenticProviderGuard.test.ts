import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveCompareConfig } from "../src/agentic/providerGuard.js";

const local = { LLM_PROVIDER: "ollama", OLLAMA_MODEL: "qwen2.5:7b" };

test("refuses when LLM_PROVIDER is unset", () => {
  const result = resolveCompareConfig({ OLLAMA_MODEL: "qwen2.5:7b" });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.message, /LLM_PROVIDER is unset/);
});

test("refuses when LLM_PROVIDER is anthropic, and says the API is not called", () => {
  const result = resolveCompareConfig({ LLM_PROVIDER: "anthropic", OLLAMA_MODEL: "qwen2.5:7b" });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.message, /LLM_PROVIDER=anthropic/);
});

test("refuses other providers, which the arms cannot share", () => {
  for (const provider of ["gemini", "mock"]) {
    const result = resolveCompareConfig({ LLM_PROVIDER: provider, OLLAMA_MODEL: "qwen2.5:7b" });
    assert.equal(result.ok, false, `${provider} should be refused`);
  }
});

test("refuses when OLLAMA_MODEL is unset, so no arm can pick its own model", () => {
  const result = resolveCompareConfig({ LLM_PROVIDER: "ollama" });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.message, /OLLAMA_MODEL is unset/);
});

test("accepts ollama with a model, and resolves one config for every arm", () => {
  const result = resolveCompareConfig({ ...local, OLLAMA_PRICING_MODEL: "gemini-3.8-flash" });
  assert.ok(result.ok);
  assert.deepEqual(result.config, {
    provider: "ollama",
    model: "qwen2.5:7b",
    baseUrl: "http://localhost:11434",
    pricingModel: "gemini-3.8-flash",
  });
});

test("whitespace-only values are treated as unset", () => {
  assert.equal(resolveCompareConfig({ LLM_PROVIDER: "  ", OLLAMA_MODEL: "x" }).ok, false);
  assert.equal(resolveCompareConfig({ LLM_PROVIDER: "ollama", OLLAMA_MODEL: "  " }).ok, false);
});
