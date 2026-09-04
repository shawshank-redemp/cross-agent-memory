// Tests for the guardrail layer — the code that decides whether money leaves
// the business. Table-driven over signal combinations.
//
// node:test + tsx deliberately: a heavier framework would be more machinery
// than this needs, and `npm test` running by default matters more than features.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";

import { decideWithMemory, enforcePolicy } from "../src/agents/memoryContext.js";
import { CartAbandonmentDecisionSchema } from "../src/agents/schema.js";
import { applyBaselinePolicy, enforceUniversalPolicy, spendCeilingPaise } from "../src/agents/enforcement.js";
import { appendAuditLog, computeMemoryProfile, recordDiscountUsage } from "../src/memory/profile.js";
import type { MemorySignals, TriggeringEventFacts } from "../src/agents/policy.js";
import type { AgentType } from "../src/types/index.js";

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

// All signals inactive. Individual cases override only what they are about.
function signals(overrides: Partial<MemorySignals> = {}): MemorySignals {
  return {
    disputeCautionLevel: "none",
    discountsGrantedByThisAgent: 0,
    discountLimitReached: false,
    repeatRecoveryWithThisAgent: false,
    repeatRecoveryAcrossAgents: false,
    crossAgentSpendLimitReached: false,
    pastDiscountsIneffective: false,
    recentMultiDomainTrouble: false,
    provenPayer: false,
    ...overrides,
  };
}

const EVENT_AMOUNT = 100_000; // paise

function facts(agent: AgentType = "cart_abandonment", amount = EVENT_AMOUNT): TriggeringEventFacts {
  return {
    agent,
    timestamp: "2026-06-01T00:00:00.000Z",
    amount,
    paymentAttempted: false,
    paymentErrorCode: null,
  };
}

function decision(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    reasoning: "a sufficiently long reasoning string for the decision under test",
    memory_factors_used: [] as string[],
    action: "send_discount",
    committed_spend_paise: 10_000 as number | null,
    escalate_to_human: false,
    escalation_reason: null as string | null,
    ...overrides,
  };
}

function run(d: ReturnType<typeof decision>, s: MemorySignals, f = facts()) {
  const db = memDb();
  const traceBase = {
    db,
    customerId: "cust_t",
    eventId: "order_t",
    agent: f.agent,
    mode: "memory" as const,
  };
  const out = enforcePolicy(d, s, f, traceBase, 1);
  db.close();
  return out;
}

// ---------------------------------------------------------------- pass-through

test("no active signal: decision passes through untouched, no override", () => {
  const d = decision();
  const out = run(d, signals());
  assert.equal(out.action, "send_discount");
  assert.equal(out.committed_spend_paise, 10_000);
  assert.equal(out.escalate_to_human, false);
  assert.equal(out.policy_override, null);
  assert.equal(out.reasoning, d.reasoning, "reasoning must not be annotated when nothing fired");
});

// ---------------------------------------------------------------------- blocks

test("blocking signal + proposed spend: spend nulled, action swapped, original preserved", () => {
  const out = run(decision({ committed_spend_paise: 20_000 }), signals({ discountLimitReached: true }));
  assert.equal(out.committed_spend_paise, null);
  assert.equal(out.action, "send_reminder", "cart's non-spend fallback");
  assert.ok(out.policy_override);
  assert.equal(out.policy_override.original_action, "send_discount");
  assert.equal(out.policy_override.original_committed_spend_paise, 20_000);
  assert.equal(out.policy_override.original_escalate_to_human, false);
  assert.ok(out.policy_override.triggered_by.includes("discountLimitReached"));
});

// BLOCKING AND ESCALATING ARE SEPARATE, and this is the pair of tests that pins
// it. They used to be welded together in every brake that had either, which
// forced a human handoff on 41.9% of all events and made the run's headline
// revenue figure a measure of handoff volume rather than of spending judgment.
test("blocking does NOT escalate: refusing to spend is not a reason to call a person", () => {
  const out = run(decision({ committed_spend_paise: 20_000 }), signals({ discountLimitReached: true }));
  assert.equal(out.committed_spend_paise, null, "spend is still blocked");
  assert.equal(out.escalate_to_human, false, "but nobody is paged for it");
  assert.equal(out.escalation_reason, null);
});

test("escalating does NOT block: a churn handoff still leaves the human a budget", () => {
  const out = run(decision({ committed_spend_paise: 15_000 }), signals({ recentMultiDomainTrouble: true }));
  assert.equal(out.escalate_to_human, true);
  assert.equal(out.escalation_reason, "policy_constraint");
  assert.equal(out.committed_spend_paise, 15_000, "spend survives — the person decides, not the block");
  assert.equal(out.action, "send_discount", "and the action is not swapped out from under them");
  assert.ok(out.policy_override);
  assert.ok(out.policy_override.triggered_by.includes("recentMultiDomainTrouble"));
  assert.equal(out.policy_override.escalation_reason_forced, true);
});

// ------------------------------------------------------------------------ caps

test("cap only: spend clamped, action unchanged, escalation NOT forced", () => {
  // unresolved_customer_fault => 10% of 100000 = 10000
  const out = run(decision({ committed_spend_paise: 50_000 }), signals({
    disputeCautionLevel: "unresolved_customer_fault",
  }));
  assert.equal(out.committed_spend_paise, 10_000);
  assert.equal(out.action, "send_discount", "a clamp prices the decision, it does not change it");
  assert.equal(out.escalate_to_human, false, "capping alone must not force escalation");
  assert.ok(out.policy_override);
});

test("two active caps: the LOWER wins (brakes beat accelerators)", () => {
  const out = run(decision({ committed_spend_paise: 90_000 }), signals({
    disputeCautionLevel: "unresolved_customer_fault", // 10%
    provenPayer: true, // 25%
  }));
  assert.equal(out.committed_spend_paise, 10_000, "min(10%, 25%) of 100000");
});

// `adverse` is the one caution level that BLOCKS rather than caps. It used to
// share the 10% ceiling with unresolved_customer_fault, which treated a bank's
// actual ruling as equivalent to an unproven allegation whose only evidence is
// which reason the customer picked from a dropdown.
test("adverse blocks outright rather than capping, and still does not escalate", () => {
  const out = run(decision({ committed_spend_paise: 5_000 }), signals({ disputeCautionLevel: "adverse" }));
  assert.equal(out.committed_spend_paise, null, "a ruled dispute blocks spend at ANY amount");
  assert.equal(out.action, "send_reminder");
  assert.equal(out.escalate_to_human, false, "a ruling is unambiguous; a person adds nothing");
  assert.ok(out.policy_override);
  assert.ok(out.policy_override.triggered_by.includes("disputeCautionLevel"));
});

// A ceiling only bites when the model wanted to spend MORE than it. This is the
// case that made capping `adverse` unsafe: a small proposed discount slips
// under a 10% ceiling untouched, so the strongest negative evidence in a
// payments business would have changed nothing at all.
test("a cap would NOT have caught a small adverse discount, which is why it blocks", () => {
  const capped = run(
    decision({ committed_spend_paise: 5_000 }),
    signals({ disputeCautionLevel: "unresolved_customer_fault" }),
  );
  assert.equal(capped.committed_spend_paise, 5_000, "5000 is under the 10% ceiling and survives a cap");
});

test("provenPayer alone: ceiling rises to 25%, proving the default is a fallback not a participant", () => {
  const out = run(decision({ committed_spend_paise: 24_000 }), signals({ provenPayer: true }));
  assert.equal(out.committed_spend_paise, 24_000, "24000 is under the 25% ceiling and must survive");
  assert.equal(out.policy_override, null);

  const clamped = run(decision({ committed_spend_paise: 30_000 }), signals({ provenPayer: true }));
  assert.equal(clamped.committed_spend_paise, 25_000, "clamped to 25%, not to the 20% default");
});

test("provenPayer + a blocking signal: blocked, not accelerated", () => {
  const out = run(decision({ committed_spend_paise: 24_000 }), signals({
    provenPayer: true,
    discountLimitReached: true,
  }));
  assert.equal(out.committed_spend_paise, null);
  assert.equal(out.action, "send_reminder");
});

// ------------------------------------------------------------------- coherence

test("coherence: spend on a non-spend action is nulled and the action is NOT swapped", () => {
  const out = run(decision({ action: "no_action", committed_spend_paise: 5_000 }), signals());
  assert.equal(out.committed_spend_paise, null);
  assert.equal(out.action, "no_action", "the guardrail must not turn no_action into an outbound message");
  assert.ok(out.policy_override);
  assert.ok(out.policy_override.triggered_by.includes("action_spend_incoherent"));
});

test("coherence runs before blocking: no_action + spend + blocking signal still yields no_action", () => {
  const out = run(
    decision({ action: "no_action", committed_spend_paise: 5_000 }),
    signals({ discountLimitReached: true }),
  );
  assert.equal(out.action, "no_action", "block must not resurrect an action swap on already-incoherent spend");
  assert.equal(out.committed_spend_paise, null);
});

test("coherence: the dispute agent can never carry spend", () => {
  const out = run(
    decision({ action: "accept_dispute", committed_spend_paise: 7_000 }),
    signals(),
    facts("dispute_responder"),
  );
  assert.equal(out.committed_spend_paise, null);
  assert.equal(out.action, "accept_dispute");
});

// ---------------------------------------------------------------------- bounds

test("bounds: negative spend is rejected as malformed", () => {
  const out = run(decision({ committed_spend_paise: -5_000 }), signals());
  assert.equal(out.committed_spend_paise, null);
  assert.ok(out.policy_override);
  assert.ok(out.policy_override.triggered_by.includes("negative_spend_rejected"));
});

test("bounds: zero spend is never written, and falls back to the non-spend action", () => {
  const out = run(decision({ committed_spend_paise: 0 }), signals());
  assert.equal(out.committed_spend_paise, null);
  assert.equal(out.action, "send_reminder");
  assert.ok(out.policy_override);
  assert.ok(out.policy_override.triggered_by.includes("zero_spend_rejected"));
});

test("bounds: a zero-amount event cannot produce a discount (the noise scenario)", () => {
  const out = run(decision({ committed_spend_paise: 4_000 }), signals(), facts("cart_abandonment", 0));
  assert.equal(out.committed_spend_paise, null, "ceiling of a zero-value cart is 0, so no spend survives");
  assert.equal(out.action, "send_reminder");
});

test("spendCeilingPaise guards zero, negative and non-finite amounts", () => {
  assert.equal(spendCeilingPaise(0, 20), 0);
  assert.equal(spendCeilingPaise(-100, 20), 0);
  assert.equal(spendCeilingPaise(Number.NaN, 20), 0);
  assert.equal(spendCeilingPaise(100_000, 20), 20_000);
});

// ------------------------------------------------------------ universal / arms

test("universal policy applies to the baseline arm with the default 20% ceiling", () => {
  const out = applyBaselinePolicy(decision({ committed_spend_paise: 90_000 }), {
    agent: "cart_abandonment",
    eventAmount: EVENT_AMOUNT,
  });
  assert.equal(out.committed_spend_paise, 20_000, "clamped to the universal default, with no memory involved");
  assert.ok(out.policy_override);
  assert.ok(out.policy_override.triggered_by.includes("spend_ceiling"));
});

test("both arms clamp identically when no signal tightens the cap", () => {
  const baseline = applyBaselinePolicy(decision({ committed_spend_paise: 90_000 }), {
    agent: "cart_abandonment",
    eventAmount: EVENT_AMOUNT,
  });
  const memory = run(decision({ committed_spend_paise: 90_000 }), signals());
  assert.equal(
    baseline.committed_spend_paise,
    memory.committed_spend_paise,
    "the universal layer must not differ between arms — that difference would be a confound",
  );
});

test("escalation_reason is normalised: set when escalating, null when not", () => {
  const escalating = enforceUniversalPolicy(decision({ escalate_to_human: true }), {
    agent: "cart_abandonment",
    eventAmount: EVENT_AMOUNT,
  });
  assert.equal(escalating.decision.escalate_to_human, true);

  const out = applyBaselinePolicy(decision({ escalate_to_human: true, escalation_reason: null }), {
    agent: "cart_abandonment",
    eventAmount: EVENT_AMOUNT,
  });
  assert.equal(out.escalation_reason, "ambiguous_case");

  const notEscalating = applyBaselinePolicy(
    decision({ escalate_to_human: false, escalation_reason: "high_value" }),
    { agent: "cart_abandonment", eventAmount: EVENT_AMOUNT },
  );
  assert.equal(notEscalating.escalation_reason, null, "a reason without an escalation is noise");
});

// -------------------------------------------------------------------- temporal

test("temporal: a profile read at asOf T does not see a discount recorded at T+1", () => {
  const db = memDb();
  recordDiscountUsage(db, {
    customer_id: "cust_t",
    agent: "cart_abandonment",
    mode: "memory",
    amount: 5_000,
    event_id: "order_past",
    timestamp: "2026-06-01T00:00:00.000Z",
  });
  recordDiscountUsage(db, {
    customer_id: "cust_t",
    agent: "cart_abandonment",
    mode: "memory",
    amount: 7_000,
    event_id: "order_future",
    timestamp: "2026-06-10T00:00:00.000Z",
  });

  const atT = computeMemoryProfile(db, "cust_t", "memory", "2026-06-05T00:00:00.000Z");
  assert.equal(atT.discount_usage_history.length, 1, "the later discount has not happened yet");
  assert.equal(atT.discount_usage_history[0]?.event_id, "order_past");

  const finalState = computeMemoryProfile(db, "cust_t", "memory");
  assert.equal(finalState.discount_usage_history.length, 2, "omitting asOf must still return everything");
  db.close();
});

test("temporal: audit_log is asOf-scoped too, so recent_decisions cannot see the future", () => {
  const db = memDb();
  const insert = db.prepare(
    `INSERT INTO audit_log (timestamp, customer_id, agent, mode, entry_type, event_id, action, reasoning)
     VALUES (?, 'cust_t', 'cart_abandonment', 'memory', 'decision', ?, 'send_reminder', 'r')`,
  );
  insert.run("2026-06-01T00:00:00.000Z", "order_past");
  insert.run("2026-06-10T00:00:00.000Z", "order_future");

  const atT = computeMemoryProfile(db, "cust_t", "memory", "2026-06-05T00:00:00.000Z");
  assert.equal(atT.audit_log.length, 1);
  assert.equal(computeMemoryProfile(db, "cust_t", "memory").audit_log.length, 2);
  db.close();
});

// --------------------------------------------------------------- idempotency

test("idempotency: re-recording a discount for the same (event_id, mode) replaces, never duplicates", () => {
  const db = memDb();
  const write = (amount: number) =>
    recordDiscountUsage(db, {
      customer_id: "cust_t",
      agent: "cart_abandonment",
      mode: "memory",
      amount,
      event_id: "order_same",
      timestamp: "2026-06-01T00:00:00.000Z",
    });

  write(5_000);
  write(8_000); // a --resume re-decide of the same event

  const rows = db.prepare("SELECT amount FROM discount_usage WHERE event_id = 'order_same'").all() as {
    amount: number;
  }[];
  assert.equal(rows.length, 1, "a re-decide must replace, not duplicate");
  assert.equal(rows[0]?.amount, 8_000, "and the newer decision must win");

  // The same event in the OTHER arm is a separate row, not a conflict.
  recordDiscountUsage(db, {
    customer_id: "cust_t",
    agent: "cart_abandonment",
    mode: "baseline",
    amount: 3_000,
    event_id: "order_same",
    timestamp: "2026-06-01T00:00:00.000Z",
  });
  assert.equal(
    (db.prepare("SELECT COUNT(*) c FROM discount_usage WHERE event_id = 'order_same'").get() as { c: number }).c,
    2,
    "the two arms are independent hypotheticals and must not collide",
  );
  db.close();
});

test("idempotency: audit_log decision and memory_read rows coexist and each de-duplicates", () => {
  const db = memDb();
  const write = (entryType: "memory_read" | "decision", reasoning: string) =>
    appendAuditLog(db, {
      customer_id: "cust_t",
      agent: "cart_abandonment",
      mode: "memory",
      entry_type: entryType,
      event_id: "order_same",
      action: entryType === "decision" ? "send_reminder" : "read_memory_profile",
      reasoning,
      timestamp: "2026-06-01T00:00:00.000Z",
    });

  write("memory_read", "first read");
  write("decision", "first decision");
  write("decision", "second decision after a resume");

  const rows = db
    .prepare("SELECT entry_type, reasoning FROM audit_log WHERE event_id = 'order_same' ORDER BY entry_type")
    .all() as { entry_type: string; reasoning: string }[];
  assert.equal(rows.length, 2, "one memory_read + one decision, the re-decide having replaced");
  assert.equal(rows.find((r) => r.entry_type === "decision")?.reasoning, "second decision after a resume");
  db.close();
});

// ------------------------------------------------------------------ fail closed

test("fail closed: an unevaluable guardrail yields no spend and a human handoff", async () => {
  const db = memDb();
  // A DB with the customers table dropped makes the profile read throw.
  db.exec("DROP TABLE dispute_events");
  const out = await decideWithMemory({
    db,
    customer: { customer_id: "cust_t", name: "T", email: "t@e.com", contact: "+910000000000",
      signup_date: "2026-01-01T00:00:00.000Z", plan_tier: "basic" },
    agent: "cart_abandonment",
    event: {},
    eventId: "order_t",
    eventTimestamp: "2026-06-01T00:00:00.000Z",
    eventFacts: { amount: EVENT_AMOUNT, paymentAttempted: false, paymentErrorCode: null },
    systemPrompt: "unused — the guardrail fails before any model call",
    schema: CartAbandonmentDecisionSchema,
    memoryReadReason: "test",
  });
  db.close();

  assert.equal(out.committed_spend_paise, null, "a guardrail that cannot evaluate must commit no spend");
  assert.equal(out.escalate_to_human, true);
  assert.equal(out.escalation_reason, "policy_constraint");
  assert.equal(out.action, "send_reminder");
  assert.equal(out.guardrail_failed, true);
  assert.equal(out.signals, null);
  assert.ok(out.policy_override?.triggered_by.includes("guardrail_evaluation_failed"));
});
