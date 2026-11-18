import assert from "node:assert/strict";
import { test } from "node:test";
import { scaleLift, scoreWithProbs, publishedProbs } from "../src/analysis/armScoring.js";
import { resolveRecoveryOutcome, rollsForEvent } from "../src/outcomes/resolveOutcomes.js";
import { OUTCOME_PROBABILITIES } from "../src/outcomes/probabilities.js";
import type { Scenario } from "../src/data/generator.js";

const SCENARIOS = Object.keys(OUTCOME_PROBABILITIES) as Scenario[];

// A fixed pseudo-random sequence, so the test is deterministic.
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test("scoreWithProbs with the published probabilities equals resolveRecoveryOutcome", () => {
  const rand = lcg(42);
  for (let i = 0; i < 2000; i += 1) {
    const scenario = SCENARIOS[Math.floor(rand() * SCENARIOS.length)]!;
    const eventId = `order_eq_${i}`;
    const gross = 1_000 + Math.floor(rand() * 500_000);
    const spend = rand() < 0.4 ? null : Math.floor(rand() * gross * 0.2);
    const escalate = rand() < 0.1;
    const decision = { committed_spend_paise: spend, escalate_to_human: escalate };
    const rolls = rollsForEvent(eventId);
    const real = resolveRecoveryOutcome(eventId, "cart_abandonment", scenario, gross, decision, rolls);
    const copy = scoreWithProbs({
      eventId,
      scenario,
      grossAmount: gross,
      decision,
      rolls,
      probs: publishedProbs(scenario),
    });
    assert.deepEqual(copy, real, `mismatch at case ${i} (${scenario})`);
  }
});

test("scaleLift at k = 1 returns the published probabilities exactly", () => {
  for (const scenario of SCENARIOS) {
    assert.deepEqual(scaleLift(publishedProbs(scenario), 1), publishedProbs(scenario));
  }
});

test("scaleLift at k = 0 removes the lift, and values stay within [0, 1]", () => {
  for (const scenario of SCENARIOS) {
    const p = publishedProbs(scenario);
    assert.equal(scaleLift(p, 0).paysWithDiscount, p.paysWithoutDiscount);
    for (const k of [0.25, 0.5, 2, 10]) {
      const s = scaleLift(p, k);
      assert.ok(s.paysWithDiscount >= 0 && s.paysWithDiscount <= 1);
      assert.equal(s.paysWithoutDiscount, p.paysWithoutDiscount);
    }
  }
});
