// Read-only measurement: how often does composite churn fire under the OLD
// window-pair rule vs the NEW recency-bounded lookback?
//
// The point is to quantify how much of the committed comparison report was
// driven by the loose window rule rather than by genuine cross-agent signal.
// The old rule compared each agent's aggregate window (first event to last
// event) and fired when two windows came within 14 days of each other — a
// window can span months, and it never ages out, so a bad fortnight eight
// months ago still trips the signal today.
//
// BOTH rules are reimplemented locally as pure functions rather than calling
// into policy.ts. That is deliberate: this script is a measurement
// INSTRUMENT, and it has to give the same before/after table whether it runs
// before or after the refactor lands. If it called the live implementation,
// the "NEW" column would silently become whatever policy.ts happens to say.
// After the refactor a cross-check confirms the live rule agrees with the
// local NEW rule here.
//
// Writes nothing and makes no API calls.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/db/connection.js";
import {
  CART_ELIGIBLE_SQL,
  DISPUTE_ELIGIBLE_SQL,
  SUBSCRIPTION_ELIGIBLE_SQL,
} from "../src/db/eligibility.js";
import { computeMemoryProfile } from "../src/memory/profile.js";
import { computeMemorySignals, type TriggeringEventFacts } from "../src/agents/policy.js";
import type { AgentType } from "../src/types/index.js";
import type { Scenario, ScenarioLabel } from "../src/data/generator.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const CHURN_DAYS = 14;

const GENERATED_DIR = join(import.meta.dirname, "..", "data", "generated");

interface RecoveryEvent {
  agent: AgentType;
  ts: number;
}

// The population is the RECOVERY-FLOW triggering events, matching the filters
// NOTE: this population is NOT db/eligibility.ts, and must not become it.
//
// It mirrors profile.ts's readRecoveryFrequency/readRecentEvents, which count
// ALL disputes regardless of status — a ruled dispute still happened and is
// still evidence about the customer. Eligibility excludes ruled disputes,
// because the responder has nothing left to file. The two agree on carts and
// subscriptions and diverge on disputes by design; sharing a constant here
// would let a change to the decision queue silently redefine what composite
// churn measures.
// readRecoveryFrequency already uses: a paid cart and an active subscription
// cycle do not fire a recovery flow, so neither is evidence of churn. Holding
// this population fixed across both rules is what makes the comparison below
// isolate the WINDOW LOGIC rather than confounding it with a population
// change.
function loadRecoveryEventsByCustomer(): Map<string, RecoveryEvent[]> {
  const db = openDb();
  const rows: { customer_id: string; agent: AgentType; at: string }[] = [
    ...(db
      .prepare("SELECT customer_id, created_at AS at FROM cart_abandonment_events WHERE status != 'paid'")
      .all() as { customer_id: string; at: string }[]).map((r) => ({ ...r, agent: "cart_abandonment" as const })),
    ...(db
      .prepare("SELECT customer_id, created_at AS at FROM subscription_failure_events WHERE status IN ('failed','halted')")
      .all() as { customer_id: string; at: string }[]).map((r) => ({ ...r, agent: "subscription_recovery" as const })),
    // ALL disputes, deliberately unfiltered — see the note above.
    ...(db.prepare("SELECT customer_id, dispute_created_at AS at FROM dispute_events").all() as {
      customer_id: string;
      at: string;
    }[]).map((r) => ({ ...r, agent: "dispute_responder" as const })),
  ];
  db.close();

  const byCustomer = new Map<string, RecoveryEvent[]>();
  for (const r of rows) {
    const list = byCustomer.get(r.customer_id) ?? [];
    list.push({ agent: r.agent, ts: Date.parse(r.at) });
    byCustomer.set(r.customer_id, list);
  }
  for (const list of byCustomer.values()) list.sort((a, b) => a.ts - b.ts);
  return byCustomer;
}

// Every event the runner decides on. That is now the recovery-eligible set —
// the shared definition in db/eligibility.ts, imported rather than restated so
// this denominator cannot drift away from what the runner actually processes.
//
// It used to be every row in all three tables, back when the runner decided on
// paid carts and active cycles too.
function loadAllDecisionPoints(): { customer_id: string; ts: number }[] {
  const db = openDb();
  const rows = [
    ...(db.prepare(`SELECT customer_id, created_at AS at FROM cart_abandonment_events WHERE ${CART_ELIGIBLE_SQL}`).all() as {
      customer_id: string;
      at: string;
    }[]),
    ...(db.prepare(`SELECT customer_id, created_at AS at FROM subscription_failure_events WHERE ${SUBSCRIPTION_ELIGIBLE_SQL}`).all() as {
      customer_id: string;
      at: string;
    }[]),
    ...(db.prepare(`SELECT customer_id, dispute_created_at AS at FROM dispute_events WHERE ${DISPUTE_ELIGIBLE_SQL}`).all() as {
      customer_id: string;
      at: string;
    }[]),
  ];
  db.close();
  return rows.map((r) => ({ customer_id: r.customer_id, ts: Date.parse(r.at) }));
}

// OLD RULE (being replaced). Aggregate each agent's events visible as of the
// decision into a single [first, last] window, then fire if ANY two windows
// come within 14 days of each other. Two failure modes: a window can span
// months, so events 36 days apart can still "be within 14 days"; and nothing
// ages out, so an old cluster keeps firing forever.
export function firesUnderOldWindowRule(events: RecoveryEvent[], asOf: number): boolean {
  const windows = new Map<AgentType, { start: number; end: number }>();
  for (const e of events) {
    if (e.ts > asOf) continue;
    const w = windows.get(e.agent);
    if (!w) windows.set(e.agent, { start: e.ts, end: e.ts });
    else {
      w.start = Math.min(w.start, e.ts);
      w.end = Math.max(w.end, e.ts);
    }
  }
  const list = [...windows.values()];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]!;
      const b = list[j]!;
      const gapMs = Math.max(a.start - b.end, b.start - a.end);
      if (gapMs <= CHURN_DAYS * DAY_MS) return true;
    }
  }
  return false;
}

// NEW RULE. Two or more distinct domains have at least one event in the 14
// days immediately preceding and including the decision point. Recency-bounded
// and self-ageing.
export function firesUnderNewLookbackRule(events: RecoveryEvent[], asOf: number): boolean {
  const floor = asOf - CHURN_DAYS * DAY_MS;
  const domains = new Set<AgentType>();
  for (const e of events) {
    if (e.ts <= asOf && e.ts >= floor) domains.add(e.agent);
  }
  return domains.size >= 2;
}

function main(): void {
  const labels = JSON.parse(readFileSync(join(GENERATED_DIR, "scenario_labels.json"), "utf-8")) as ScenarioLabel[];
  const scenarioByCustomer = new Map(labels.map((l) => [l.customer_id, l.scenario]));
  const eventsByCustomer = loadRecoveryEventsByCustomer();
  const decisionPoints = loadAllDecisionPoints();

  interface Row {
    events: number;
    old: number;
    fresh: number;
  }
  const byScenario = new Map<Scenario, Row>();
  let totalEvents = 0;
  let totalOld = 0;
  let totalNew = 0;

  for (const point of decisionPoints) {
    const scenario = scenarioByCustomer.get(point.customer_id) ?? ("normal" as Scenario);
    const events = eventsByCustomer.get(point.customer_id) ?? [];
    const oldFires = firesUnderOldWindowRule(events, point.ts);
    const newFires = firesUnderNewLookbackRule(events, point.ts);

    const row = byScenario.get(scenario) ?? { events: 0, old: 0, fresh: 0 };
    row.events += 1;
    if (oldFires) row.old += 1;
    if (newFires) row.fresh += 1;
    byScenario.set(scenario, row);

    totalEvents += 1;
    if (oldFires) totalOld += 1;
    if (newFires) totalNew += 1;
  }

  const pad = (s: string, n: number) => s.padEnd(n);
  const padL = (s: string, n: number) => s.padStart(n);
  console.log("Composite churn signal: OLD window-pair rule vs NEW 14-day lookback\n");
  console.log(
    `${pad("scenario", 30)}${padL("events", 8)}${padL("OLD", 8)}${padL("NEW", 8)}${padL("delta", 8)}${padL("old%", 8)}${padL("new%", 8)}`,
  );
  console.log("-".repeat(78));

  const sorted = [...byScenario.entries()].sort((a, b) => b[1].old - a[1].old);
  for (const [scenario, row] of sorted) {
    const delta = row.fresh - row.old;
    console.log(
      pad(scenario, 30) +
        padL(String(row.events), 8) +
        padL(String(row.old), 8) +
        padL(String(row.fresh), 8) +
        padL(delta > 0 ? `+${delta}` : String(delta), 8) +
        padL(`${Math.round((row.old / row.events) * 100)}%`, 8) +
        padL(`${Math.round((row.fresh / row.events) * 100)}%`, 8),
    );
  }
  console.log("-".repeat(78));
  const totalDelta = totalNew - totalOld;
  console.log(
    pad("ALL", 30) +
      padL(String(totalEvents), 8) +
      padL(String(totalOld), 8) +
      padL(String(totalNew), 8) +
      padL(totalDelta > 0 ? `+${totalDelta}` : String(totalDelta), 8) +
      padL(`${Math.round((totalOld / totalEvents) * 100)}%`, 8) +
      padL(`${Math.round((totalNew / totalEvents) * 100)}%`, 8),
  );

  console.log(
    `\nOverall fire rate: OLD ${((totalOld / totalEvents) * 100).toFixed(1)}%  ->  NEW ${(
      (totalNew / totalEvents) *
      100
    ).toFixed(1)}%`,
  );
  console.log(
    `churn_signal is the only scenario the generator plants as a genuine composite pattern; every\nfiring outside it under the OLD rule is the window rule reaching across unrelated events.`,
  );

  crossCheckAgainstLiveRule(decisionPoints, eventsByCustomer);
}

// Confirms the LIVE implementation in the signal registry agrees with the
// local NEW rule above. Before the refactor this necessarily disagrees (the
// live rule is still the window-pair one), which is itself informative; after
// it, any disagreement means the reimplementation here has drifted from
// production and the table above can no longer be trusted.
function crossCheckAgainstLiveRule(
  decisionPoints: { customer_id: string; ts: number }[],
  eventsByCustomer: Map<string, RecoveryEvent[]>,
): void {
  const db = openDb();
  let checked = 0;
  let disagreements = 0;
  let firstDisagreement = "";

  // A sample is enough to catch drift and keeps the script fast; every 7th
  // point spreads the sample across scenarios rather than clustering.
  for (let i = 0; i < decisionPoints.length; i += 7) {
    const point = decisionPoints[i]!;
    const asOf = new Date(point.ts).toISOString();
    const facts: TriggeringEventFacts = {
      agent: "cart_abandonment",
      timestamp: asOf,
      amount: 0,
      paymentAttempted: false,
      paymentErrorCode: null,
    };
    const live = computeMemorySignals(computeMemoryProfile(db, point.customer_id, "memory", asOf), facts)
      .compositeChurnSignal;
    const local = firesUnderNewLookbackRule(eventsByCustomer.get(point.customer_id) ?? [], point.ts);
    checked += 1;
    if (live !== local) {
      disagreements += 1;
      if (!firstDisagreement) firstDisagreement = `${point.customer_id} @ ${asOf}: live=${live} local=${local}`;
    }
  }
  db.close();

  console.log(
    `\nCross-check vs the LIVE registry rule: ${checked - disagreements}/${checked} agree` +
      (disagreements > 0 ? ` — MISMATCH, e.g. ${firstDisagreement}` : " (live implementation matches the NEW column)"),
  );
}

main();
