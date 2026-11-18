import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { recordArmDecision } from "../src/agentic/armRecording.js";
import { collectArms } from "../src/analysis/threeArmReport.js";

const SCHEMA_PATH = join(import.meta.dirname, "..", "src", "db", "schema.sql");

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(readFileSync(SCHEMA_PATH, "utf-8"));
  db.prepare(
    `INSERT INTO customers (customer_id, name, email, contact, signup_date, plan_tier)
     VALUES ('cust_rec', 'Rec', 'rec@example.com', '+910000000000', '2026-01-01', 'basic')`,
  ).run();
  return db;
}

const base = {
  customerId: "cust_rec",
  agent: "cart_abandonment" as const,
  eventId: "order_rec_1",
  orderId: "order_rec_1",
  timestamp: "2026-03-01T10:00:00.000Z",
};

test("a discounting decision writes a mode-scoped audit row and a discount row", () => {
  const db = freshDb();
  recordArmDecision(db, {
    ...base,
    mode: "memory",
    decision: { action: "send_discount", reasoning: "r", committed_spend_paise: 7_000, escalate_to_human: false },
  });
  const discount = db.prepare("SELECT mode, amount FROM discount_usage").all() as Array<{ mode: string; amount: number }>;
  assert.deepEqual(discount, [{ mode: "memory", amount: 7_000 }]);
  const audit = db.prepare("SELECT mode, action FROM audit_log WHERE entry_type='decision'").all();
  assert.deepEqual(audit, [{ mode: "memory", action: "send_discount" }]);
  db.close();
});

test("a non-spending decision writes an audit row and no discount row", () => {
  const db = freshDb();
  recordArmDecision(db, {
    ...base,
    mode: "baseline",
    decision: { action: "send_reminder", reasoning: "r", committed_spend_paise: null, escalate_to_human: false },
  });
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM discount_usage").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entry_type='decision'").get() as { n: number }).n, 1);
  db.close();
});

test("once recorded, a baseline or memory decision is visible to the three-arm report", () => {
  const db = freshDb();
  recordArmDecision(db, {
    ...base,
    mode: "baseline",
    decision: { action: "send_reminder", reasoning: "r", committed_spend_paise: null, escalate_to_human: false },
  });
  const { decisionsByEvent } = collectArms(db);
  assert.equal(decisionsByEvent.get("order_rec_1")?.get("baseline")?.source, "audit");
  db.close();
});

test("recording the same decision twice replaces it rather than duplicating", () => {
  const db = freshDb();
  const input = {
    ...base,
    mode: "memory" as const,
    decision: { action: "send_discount", reasoning: "r", committed_spend_paise: 7_000, escalate_to_human: false },
  };
  recordArmDecision(db, input);
  recordArmDecision(db, input);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM discount_usage").get() as { n: number }).n, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entry_type='decision'").get() as { n: number }).n, 1);
  db.close();
});
