// The runner reports a dollar figure from these numbers after a paid run, so a
// silent error here misstates what the run cost.
import assert from "node:assert/strict";
import test from "node:test";
import { BATCH_DISCOUNT, DEFAULT_PRICING_MODEL, costUsd, pricingFor } from "../src/lib/pricing.js";

test("the default pricing model has an entry", () => {
  assert.ok(pricingFor(DEFAULT_PRICING_MODEL), `${DEFAULT_PRICING_MODEL} must be priced`);
});

test("an unknown model returns null rather than a guess", () => {
  assert.equal(pricingFor("claude-not-a-real-model"), null);
});

test("cost is priced per million tokens", () => {
  const p = { inputPerMTok: 5, outputPerMTok: 25 };
  assert.equal(costUsd(1_000_000, 0, p), 5);
  assert.equal(costUsd(0, 1_000_000, p), 25);
  assert.equal(costUsd(0, 0, p), 0);
  // The shape the runner actually reports: 3,440 calls at 1500 in / 300 out.
  assert.ok(Math.abs(costUsd(3440 * 1500, 3440 * 300, p) - 51.6) < 0.01);
});

test("batch is half price", () => {
  assert.equal(BATCH_DISCOUNT, 0.5);
  const p = pricingFor(DEFAULT_PRICING_MODEL)!;
  assert.equal(costUsd(1_000_000, 0, p) * BATCH_DISCOUNT, p.inputPerMTok / 2);
});
