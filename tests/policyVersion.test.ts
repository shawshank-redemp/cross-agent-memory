// Tests for policy versioning: the fingerprint recorded on every decision row
// so a historical decision stays interpretable after the rules change.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";

import {
  computePolicyThresholdsHash,
  policyShapeForTesting,
  POLICY_FINGERPRINT,
  POLICY_THRESHOLDS_HASH,
  POLICY_VERSION,
} from "../src/agents/signals/policyVersion.js";
import { appendAuditLog, getMemoryProfile } from "../src/memory/profile.js";

const SCHEMA_PATH = join(import.meta.dirname, "..", "src", "db", "schema.sql");

function memDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(readFileSync(SCHEMA_PATH, "utf-8"));
  db.prepare(
    `INSERT INTO customers (customer_id, name, email, contact, signup_date, plan_tier)
     VALUES ('cust_t', 'T', 't@example.com', '+910000000000', '2026-01-01T00:00:00.000Z', 'basic')`,
  ).run();
  return db;
}

test("fingerprint is stable across calls in the same process", () => {
  assert.equal(computePolicyThresholdsHash(), POLICY_THRESHOLDS_HASH);
  assert.equal(computePolicyThresholdsHash(), computePolicyThresholdsHash());
  assert.equal(POLICY_FINGERPRINT, `${POLICY_VERSION}+${POLICY_THRESHOLDS_HASH}`);
  assert.match(POLICY_THRESHOLDS_HASH, /^[0-9a-f]{8}$/);
});

test("the hash moves when a threshold value changes", () => {
  // Computed over a MUTATED COPY — the real constants are never touched.
  const shape = policyShapeForTesting();
  const thresholds = shape.thresholds as Record<string, unknown>;
  assert.equal(thresholds.MIN_SUCCESSFUL_PAYMENTS, 2, "guard: the fixture tracks the real value");

  const mutated = {
    ...shape,
    thresholds: { ...thresholds, MIN_SUCCESSFUL_PAYMENTS: 3 },
  };
  assert.notEqual(
    computePolicyThresholdsHash(mutated),
    POLICY_THRESHOLDS_HASH,
    "changing MIN_SUCCESSFUL_PAYMENTS from 2 to 3 must move the hash",
  );

  const churn = {
    ...shape,
    thresholds: { ...thresholds, CHURN_LOOKBACK_DAYS: 30 },
  };
  assert.notEqual(computePolicyThresholdsHash(churn), POLICY_THRESHOLDS_HASH);

  // And a nested cap change, since that value is an object rather than a number.
  const caps = {
    ...shape,
    thresholds: {
      ...thresholds,
      DISCOUNT_CAP_PERCENT_BY_CAUTION_LEVEL: {
        ...(thresholds.DISCOUNT_CAP_PERCENT_BY_CAUTION_LEVEL as Record<string, number>),
        adverse: 5,
      },
    },
  };
  assert.notEqual(computePolicyThresholdsHash(caps), POLICY_THRESHOLDS_HASH);
});

test("the hash does NOT move on key order alone (canonical serialisation)", () => {
  const shape = policyShapeForTesting();
  const thresholds = shape.thresholds as Record<string, number | object>;
  // Rebuild the same values in reverse key order.
  const reordered: Record<string, unknown> = {};
  for (const key of Object.keys(thresholds).reverse()) reordered[key] = thresholds[key];
  assert.equal(
    computePolicyThresholdsHash({ ...shape, thresholds: reordered }),
    POLICY_THRESHOLDS_HASH,
    "a version that moves on declaration order is worthless",
  );
});

test("the registry shape is part of the hash: removing a signal moves it", () => {
  const shape = policyShapeForTesting();
  const signals = shape.signals as { id: string; scope: string; kind: string }[];
  assert.notEqual(
    computePolicyThresholdsHash({ ...shape, signals: signals.slice(1) }),
    POLICY_THRESHOLDS_HASH,
  );
  // And changing a signal's kind (brake -> accelerator) is a behaviour change.
  const rekinded = signals.map((s) => (s.id === "provenPayer" ? { ...s, kind: "brake" } : s));
  assert.notEqual(computePolicyThresholdsHash({ ...shape, signals: rekinded }), POLICY_THRESHOLDS_HASH);
});

test("decision rows carry policy_version in BOTH arms; memory_read rows leave it NULL", () => {
  const db = memDb();

  for (const mode of ["baseline", "memory"] as const) {
    appendAuditLog(db, {
      customer_id: "cust_t",
      agent: "cart_abandonment",
      mode,
      entry_type: "decision",
      event_id: `order_${mode}`,
      action: "send_reminder",
      reasoning: "a decision row, which is governed by a policy",
      escalate_to_human: false,
      policyVersion: POLICY_FINGERPRINT,
      timestamp: "2026-06-01T00:00:00.000Z",
    });
  }

  // A real memory_read, written by the production path rather than by hand.
  getMemoryProfile(db, "cust_t", {
    requestedBy: "cart_abandonment",
    mode: "memory",
    reason: "test read",
    asOf: "2026-06-01T00:00:00.000Z",
    eventId: "order_read",
  });

  const rows = db
    .prepare("SELECT mode, entry_type, policy_version FROM audit_log ORDER BY entry_type, mode")
    .all() as { mode: string; entry_type: string; policy_version: string | null }[];

  const decisions = rows.filter((r) => r.entry_type === "decision");
  assert.equal(decisions.length, 2, "one decision row per arm");
  for (const row of decisions) {
    assert.equal(row.policy_version, POLICY_FINGERPRINT, `${row.mode} decision must record its policy`);
  }

  const reads = rows.filter((r) => r.entry_type === "memory_read");
  assert.equal(reads.length, 1);
  assert.equal(reads[0]?.policy_version, null, "a read decides nothing, so no policy governed it");
  db.close();
});
