// The SQL fragments and the predicate functions are two expressions of one
// rule, used in different places: the fragments run inside SQLite in the
// runner's queries, the predicates run in TypeScript. If they ever disagree,
// the runner would decide on a different set of events than any in-process
// check believes it decides on — and nothing would report the discrepancy.
//
// So this walks EVERY value of each status enum through both paths against a
// real SQLite database and asserts they agree, rather than testing a sample.

import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";

import {
  ALL_CART_STATUSES,
  ALL_DISPUTE_STATUSES,
  ALL_SUBSCRIPTION_STATUSES,
  CART_ELIGIBLE_SQL,
  DISPUTE_ELIGIBLE_SQL,
  SUBSCRIPTION_ELIGIBLE_SQL,
  isCartEligible,
  isDisputeEligible,
  isSubscriptionEligible,
} from "../src/db/eligibility.js";

// One row per status value, so the SELECT returns exactly the statuses the
// fragment considers eligible.
function statusesPassingSql(statuses: readonly string[], fragment: string): Set<string> {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE t (status TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO t (status) VALUES (?)");
  for (const s of statuses) insert.run(s);
  const rows = db.prepare(`SELECT status FROM t WHERE ${fragment}`).all() as { status: string }[];
  db.close();
  return new Set(rows.map((r) => r.status));
}

const cases = [
  {
    name: "cart",
    statuses: ALL_CART_STATUSES,
    sql: CART_ELIGIBLE_SQL,
    predicate: isCartEligible as (s: string) => boolean,
    expected: ["created", "attempted"],
  },
  {
    name: "subscription",
    statuses: ALL_SUBSCRIPTION_STATUSES,
    sql: SUBSCRIPTION_ELIGIBLE_SQL,
    predicate: isSubscriptionEligible as (s: string) => boolean,
    expected: ["failed", "halted"],
  },
  {
    name: "dispute",
    statuses: ALL_DISPUTE_STATUSES,
    sql: DISPUTE_ELIGIBLE_SQL,
    predicate: isDisputeEligible as (s: string) => boolean,
    expected: ["open", "under_review"],
  },
];

for (const c of cases) {
  test(`${c.name}: SQL fragment and predicate agree on every status`, () => {
    const viaSql = statusesPassingSql(c.statuses, c.sql);
    for (const status of c.statuses) {
      assert.equal(
        viaSql.has(status),
        c.predicate(status),
        `${c.name} status "${status}": SQL says ${viaSql.has(status)}, predicate says ${c.predicate(status)}`,
      );
    }
  });

  // Agreement alone is satisfiable by both sides being wrong in the same way —
  // e.g. both matching nothing. This pins the actual expected set.
  test(`${c.name}: the eligible set is exactly ${c.expected.join(", ")}`, () => {
    assert.deepEqual([...statusesPassingSql(c.statuses, c.sql)].sort(), [...c.expected].sort());
    assert.deepEqual(c.statuses.filter(c.predicate).sort(), [...c.expected].sort());
  });

  test(`${c.name}: every terminal/no-op status is excluded`, () => {
    const excluded = c.statuses.filter((s) => !c.expected.includes(s));
    for (const status of excluded) {
      assert.equal(c.predicate(status), false, `${status} should not be eligible`);
    }
    assert.ok(excluded.length > 0, "a domain with nothing excluded would make this filter pointless");
  });
}
