import assert from "node:assert/strict";
import { test } from "node:test";
import { breakEvens, LIFT_GRID } from "../src/analysis/sensitivity.js";

test("the grid includes the published assumption, k = 1", () => {
  assert.ok((LIFT_GRID as readonly number[]).includes(1));
});

test("breakEvens finds the sign change of a step function, refined by bisection", () => {
  const roots = breakEvens((k) => k - 0.6);
  assert.equal(roots.length, 1);
  assert.ok(Math.abs(roots[0]! - 0.6) < 1e-9);
});

test("breakEvens reports none when the difference never changes sign", () => {
  assert.deepEqual(breakEvens((k) => 1 + k), []);
});
