import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { recordArmOutcome } from "../src/agentic/outcomes.js";

const SCHEMA_PATH = join(import.meta.dirname, "..", "src", "db", "schema.sql");

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(readFileSync(SCHEMA_PATH, "utf-8"));
  db.prepare(
    `INSERT INTO customers (customer_id, name, email, contact, signup_date, plan_tier)
     VALUES ('cust_out', 'Out', 'out@example.com', '+910000000000', '2026-01-01', 'basic')`,
  ).run();
  return db;
}

const base = {
  mode: "agentic" as const,
  customerId: "cust_out",
  eventId: "order_out_1",
  timestamp: "2026-03-01T10:00:00.000Z",
  grossAmountPaise: 100_000,
  decision: { action: "send_discount", committed_spend_paise: 5_000, escalate_to_human: false },
};

test("a labelled decided event records one outcome row under its arm's mode", () => {
  const db = freshDb();
  const recorded = recordArmOutcome(db, { ...base, scenario: "normal" });
  assert.equal(recorded, true);
  const rows = db
    .prepare("SELECT mode, action, committed_spend_paise, observed_at FROM intervention_outcomes")
    .all() as Array<{ mode: string; action: string; committed_spend_paise: number; observed_at: string }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.mode, "agentic");
  assert.equal(rows[0]!.action, "send_discount");
  assert.equal(rows[0]!.committed_spend_paise, 5_000);
  // Observed after the decision, never before it.
  assert.ok(Date.parse(rows[0]!.observed_at) > Date.parse(base.timestamp));
  db.close();
});

test("without a scenario label no outcome is recorded, as in the runner", () => {
  const db = freshDb();
  assert.equal(recordArmOutcome(db, { ...base, scenario: undefined }), false);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM intervention_outcomes").get() as { n: number }).n, 0);
  db.close();
});

test("the same event gets the same outcome for every arm (same dice)", () => {
  const db = freshDb();
  recordArmOutcome(db, { ...base, mode: "baseline", scenario: "normal" });
  recordArmOutcome(db, { ...base, mode: "agentic", scenario: "normal" });
  const rows = db
    .prepare("SELECT mode, converted, amount_collected_paise FROM intervention_outcomes ORDER BY mode")
    .all() as Array<{ mode: string; converted: number; amount_collected_paise: number }>;
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.converted, rows[1]!.converted);
  assert.equal(rows[0]!.amount_collected_paise, rows[1]!.amount_collected_paise);
  db.close();
});
