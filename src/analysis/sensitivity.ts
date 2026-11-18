// SENSITIVITY ANALYSIS. Not evidence.
//
// The outcome probabilities in src/outcomes/probabilities.ts are assumptions, not
// measurements. This script asks a narrow question: if the discount lift were
// larger or smaller than assumed, which arm would earn the most net?
//
// What it does:
//   - holds every stored decision fixed (the decisions were made under the
//     published assumptions, and changing the assumptions afterwards does not
//     change what the agents did);
//   - rescales only the lift in each scenario, the difference between paying
//     with and without a discount, by a factor k (scaleLift);
//   - re-scores the same events under each k with the scorer's arithmetic;
//   - finds, for memory and for agentic, the k at which its net equals the
//     baseline's net. That is the break-even lift.
//
// The k grid is fixed in this file before any result is read. It is not tuned to
// favour any arm. k = 1 is the published assumption and must reproduce the
// corrected three-arm report.
//
// Net includes escalation handling, dispute cost and recurrence cost, as the
// scorer does. Events are the same for every arm: only events all three arms
// decided, with a stored outcome for each arm.
import { openDb } from "../db/connection.js";
import { loadScenarioByCustomer } from "../agentic/outcomes.js";
import { rollsForEvent } from "../outcomes/resolveOutcomes.js";
import { publishedProbs as publishedFor, scaleLift, scoreWithProbs } from "./armScoring.js";
import { collectArms, ARMS, type Arm, type CollectedArms } from "./threeArmReport.js";
import type { Scenario } from "../data/generator.js";

// Fixed in advance. 1 is the published assumption.
export const LIFT_GRID = [0, 0.25, 0.5, 0.75, 1, 1.5, 2, 3] as const;
const BREAK_EVEN_LO = 0;
const BREAK_EVEN_HI = 3;

export interface ArmResult {
  n: number;
  paid: number;
  net: number;
}

// Scores the common events for every arm under lift factor k.
export function scoreAtLift(
  collected: CollectedArms,
  scenarioOf: Map<string, string>,
  k: number,
): Record<Arm, ArmResult> {
  const result = Object.fromEntries(ARMS.map((arm) => [arm, { n: 0, paid: 0, net: 0 }])) as Record<Arm, ArmResult>;
  for (const [eventId, byArm] of collected.common) {
    const customer = byArm.get("baseline")!.customerId;
    const scenario = scenarioOf.get(customer) as Scenario | undefined;
    const gross = collected.grossByEvent.get(eventId);
    if (!scenario || gross === undefined) continue;
    const probs = scaleLift(publishedFor(scenario), k);
    for (const arm of ARMS) {
      const stored = collected.outcomes.get(eventId)?.get(arm);
      if (!stored) continue; // as the runner: only decided, recorded events count
      const d = byArm.get(arm)!;
      const outcome = scoreWithProbs({
        eventId,
        scenario,
        grossAmount: gross,
        decision: { committed_spend_paise: d.spend > 0 ? d.spend : null, escalate_to_human: d.escalated },
        rolls: rollsForEvent(eventId),
        probs,
      });
      result[arm].n += 1;
      if (outcome.paid === true) result[arm].paid += 1;
      result[arm].net += outcome.net_revenue;
    }
  }
  return result;
}

// Bisection for a sign change of f between lo and hi.
function bisect(f: (k: number) => number, lo: number, hi: number): number {
  let a = lo;
  let b = hi;
  let fa = f(a);
  for (let i = 0; i < 60; i += 1) {
    const m = (a + b) / 2;
    const fm = f(m);
    if (Math.sign(fm) === Math.sign(fa)) {
      a = m;
      fa = fm;
    } else {
      b = m;
    }
  }
  return (a + b) / 2;
}

// Every k at which f changes sign on the grid, refined by bisection.
export function breakEvens(f: (k: number) => number): number[] {
  const roots: number[] = [];
  for (let i = 0; i < LIFT_GRID.length - 1; i += 1) {
    const lo = LIFT_GRID[i]!;
    const hi = LIFT_GRID[i + 1]!;
    if (Math.sign(f(lo)) !== Math.sign(f(hi)) && f(lo) !== 0 && f(hi) !== 0) {
      roots.push(bisect(f, lo, hi));
    }
  }
  return roots;
}

function pct(a: number, b: number): string {
  return b === 0 ? "n/a" : `${((100 * a) / b).toFixed(1)}%`;
}

function main(): void {
  const db = openDb();
  const collected = collectArms(db);
  db.close();
  if (collected.common.length === 0) {
    console.log("No events decided by all three arms. Nothing to analyse.");
    return;
  }
  const scenarioOf = loadScenarioByCustomer() as Map<string, string>;

  console.log("SENSITIVITY ANALYSIS. NOT EVIDENCE.");
  console.log("Decisions are held fixed. Only the discount lift (paysWithDiscount minus paysWithoutDiscount) is rescaled by k.");
  console.log("The k grid was fixed in advance and is not tuned to favour any arm. k = 1 is the published assumption.\n");

  const atOne = scoreAtLift(collected, scenarioOf, 1);
  console.log("k = 1 (published)");
  for (const arm of ARMS) {
    console.log(`  ${arm.padEnd(9)} conversion ${pct(atOne[arm].paid, atOne[arm].n)}  net ${atOne[arm].net} paise`);
  }

  console.log("\nGRID: conversion and net by lift factor k");
  console.log("k     | baseline conv | baseline net  | memory conv | memory net    | agentic conv | agentic net");
  for (const k of LIFT_GRID) {
    const r = scoreAtLift(collected, scenarioOf, k);
    console.log(
      `${String(k).padEnd(5)} | ${pct(r.baseline.paid, r.baseline.n).padStart(13)} | ${String(r.baseline.net).padStart(13)} | ` +
        `${pct(r.memory.paid, r.memory.n).padStart(11)} | ${String(r.memory.net).padStart(13)} | ` +
        `${pct(r.agentic.paid, r.agentic.n).padStart(12)} | ${r.agentic.net}`,
    );
  }

  console.log(`\nBREAK-EVEN LIFT (k in [${BREAK_EVEN_LO}, ${BREAK_EVEN_HI}] where the arm's net equals the baseline's net)`);
  for (const arm of ["memory", "agentic"] as const) {
    const f = (k: number) => {
      const r = scoreAtLift(collected, scenarioOf, k);
      return r[arm].net - r.baseline.net;
    };
    const roots = breakEvens(f);
    const sample = [0, 1, 3].map((k) => `k=${k}: ${arm} minus baseline = ${f(k)}`).join("; ");
    console.log(
      `  ${arm.padEnd(9)} ${roots.length === 0 ? "no break-even in range" : `break-even k = ${roots.map((r) => r.toFixed(3)).join(", ")}`}  (${sample})`,
    );
  }
  console.log(
    "\nNet is a STEP function of k: each event either pays or does not, and it flips at one threshold. " +
      "A break-even is therefore the k where one event's outcome flips, not a smooth crossing. " +
      "Where two arms share a break-even, the same flip crossed both.",
  );
  console.log(
    "A break-even says where the sign of (arm net minus baseline net) changes on the grid. " +
      "It says nothing about whether the assumed lift is realistic.",
  );
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  main();
}
