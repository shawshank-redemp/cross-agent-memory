import assert from "node:assert/strict";
import { test } from "node:test";
import { systemPrompt } from "../src/agentic/cartAbandonmentAgentic.js";
import { DISCOUNT_LIMIT_NOTE } from "../src/agentic/tools.js";

// The agentic arm over-discounted: it offered the policy limit (about 20%) in
// most events. These pin the wording that tells it the limit is a ceiling, not a
// target. Changing either one should be a deliberate decision.
test("agentic prompt labels the discount ceiling as a limit, not a target", () => {
  const prompt = systemPrompt();
  assert.match(prompt, /LIMIT, not a target/);
  assert.match(prompt, /Do not offer the limit by default/);
  assert.match(prompt, /SMALLEST committed_spend_paise/);
});

test("agentic prompt keeps the shared objective and conventions", () => {
  const prompt = systemPrompt();
  assert.match(prompt, /paise/);
  assert.match(prompt, /at most two sentences/);
});

test("the tool's limit note says the limit is not a recommended amount", () => {
  assert.match(DISCOUNT_LIMIT_NOTE, /not a recommended amount/);
  assert.match(DISCOUNT_LIMIT_NOTE, /smallest discount likely to recover the cart/);
});
