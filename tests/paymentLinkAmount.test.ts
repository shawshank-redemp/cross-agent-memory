import assert from "node:assert/strict";
import { test } from "node:test";
import { derivePaymentLinkAmount } from "../src/server/paymentLinkAmount.js";

test("payment link amount is the event amount less committed discount", () => {
  assert.equal(derivePaymentLinkAmount(100_000, 20_000), 80_000);
});

test("payment link amount is the full event amount when no discount was committed", () => {
  assert.equal(derivePaymentLinkAmount(100_000, null), 100_000);
});

test("payment link amount rejects invalid or non-positive payable totals", () => {
  assert.throws(() => derivePaymentLinkAmount(0, null), RangeError);
  assert.throws(() => derivePaymentLinkAmount(100_000, 100_000), RangeError);
  assert.throws(() => derivePaymentLinkAmount(100_000, 100_001), RangeError);
});
