import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { appendAuditLog } from "../src/memory/profile.js";
import { collectArms, tallyArm } from "../src/analysis/threeArmReport.js";

const SCHEMA_PATH = join(import.meta.dirname, "..", "src", "db", "schema.sql");
const CUST = "cust_arms";
const EVENT = "order_arms_1";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(readFileSync(SCHEMA_PATH, "utf-8"));
  db.prepare(
    `INSERT INTO customers (customer_id, name, email, contact, signup_date, plan_tier)
     VALUES (?, 'Arms', 'arms@example.com', '+910000000000', '2026-01-01', 'basic')`,
  ).run(CUST);
  return db;
}

// What decideCartAbandonment{Baseline,Memory} leave behind: a policy_override
// trace step carrying the final decision. No audit decision row.
function traceFinal(db: Database.Database, mode: "baseline" | "memory", action: string, spend: number | null, escalate: boolean) {
  db.prepare(
    `INSERT INTO agent_trace_events (customer_id, event_id, agent, mode, step_order, step_name, detail, duration_ms, started_at)
     VALUES (?, ?, 'cart_abandonment', ?, 9, 'policy_override', ?, 0, '2026-03-01T10:00:00.000Z')`,
  ).run(CUST, EVENT, mode, JSON.stringify({ applied: false, final: { action, committed_spend_paise: spend, escalate_to_human: escalate } }));
}

function agenticDecision(db: Database.Database, action: string, spend: number | null, escalate: boolean, fallback: boolean) {
  appendAuditLog(db, {
    customer_id: CUST,
    agent: "cart_abandonment",
    mode: "agentic",
    entry_type: "decision",
    event_id: EVENT,
    action,
    reasoning: "test",
    escalate_to_human: escalate,
    policyVersion: "test",
    policyOverride: fallback
      ? { original_action: "unvalidated_model_output", triggered_by: ["llm_response_validation_failed"] } as never
      : null,
    metadata: { committed_spend_paise: spend },
    timestamp: "2026-03-01T10:00:00.000Z",
  });
}

test("an event all three arms decided is compared, even when two arms only left trace steps", () => {
  const db = freshDb();
  traceFinal(db, "baseline", "send_reminder", null, false);
  traceFinal(db, "memory", "send_reminder", null, false);
  agenticDecision(db, "send_discount", 5_000, false, false);
  const { common } = collectArms(db);
  assert.equal(common.length, 1, "the old report found zero common events here");
  const byArm = common[0]![1];
  assert.equal(byArm.get("baseline")!.source, "trace");
  assert.equal(byArm.get("agentic")!.source, "audit");
  assert.equal(byArm.get("agentic")!.spend, 5_000);
  db.close();
});

test("an event missing one arm is not compared", () => {
  const db = freshDb();
  traceFinal(db, "baseline", "send_reminder", null, false);
  agenticDecision(db, "send_reminder", null, false, false);
  assert.equal(collectArms(db).common.length, 0);
  db.close();
});

test("an agentic human-review fallback is counted as a fallback and as an escalation", () => {
  const db = freshDb();
  traceFinal(db, "baseline", "send_reminder", null, false);
  traceFinal(db, "memory", "send_reminder", null, false);
  agenticDecision(db, "send_reminder", null, true, true);
  const { common, outcomes } = collectArms(db);
  const agentic = tallyArm(common, "agentic", outcomes);
  assert.equal(agentic.fallback, 1);
  assert.equal(agentic.escalated, 1);
  assert.equal(tallyArm(common, "baseline", outcomes).fallback, 0);
  db.close();
});
