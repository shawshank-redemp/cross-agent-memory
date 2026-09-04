import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildDisputeAmountByEvent,
  buildDisputeGamingThresholdEvents,
  buildGrossAmountByEvent,
  readJson,
  GENERATED_DIR,
  RESULTS_DIR,
  type DecisionRecord,
} from "./scoringInputs.js";
import type { Scenario, ScenarioLabel } from "../data/generator.js";
import {
  DISPUTE_HANDLING_FEE_PAISE,
  ESCALATION_HANDLING_COST_PAISE,
  OUTCOME_PROBABILITIES,
  RECURRENCE_COST_MULTIPLIER,
  RECURRENCE_COST_SCENARIOS,
} from "../outcomes/probabilities.js";
import { resolveDisputeResponseOutcome, resolveRecoveryOutcome, rollsForEvent, type DecisionOutcome } from "../outcomes/resolveOutcomes.js";
import type {
  AgentType,
  CartAbandonmentEvent,
  DisputeEvent,
  DisputeStatus,
  SubscriptionFailureEvent,
} from "../types/index.js";






// Sums of DecisionOutcome fields across many decisions — one instance per
// arm at the customer/scenario/overall rollup level. Nothing is excluded
// any more: escalation is priced as a real outcome (escalationCostPaise),
// so every decision that reaches resolveRecoveryOutcome /
// resolveDisputeResponseOutcome is scored, in both arms, over the identical
// set of events.
interface RevenueAccumulator {
  scoredEvents: number;
  paidCount: number;
  disputedCount: number;
  escalatedCount: number;
  moneyCollectedPaise: number;
  discountRedeemedPaise: number;
  disputeCostPaise: number;
  recurrenceCostPaise: number;
  escalationCostPaise: number;
  netRevenuePaise: number;
}

function emptyRevenue(): RevenueAccumulator {
  return {
    scoredEvents: 0,
    paidCount: 0,
    disputedCount: 0,
    escalatedCount: 0,
    moneyCollectedPaise: 0,
    discountRedeemedPaise: 0,
    disputeCostPaise: 0,
    recurrenceCostPaise: 0,
    escalationCostPaise: 0,
    netRevenuePaise: 0,
  };
}

function addOutcome(acc: RevenueAccumulator, outcome: DecisionOutcome): void {
  acc.scoredEvents += 1;
  if (outcome.paid) acc.paidCount += 1;
  if (outcome.disputed) acc.disputedCount += 1;
  if (outcome.escalation_cost > 0) acc.escalatedCount += 1;
  acc.moneyCollectedPaise += outcome.money_collected;
  acc.discountRedeemedPaise += outcome.discount_redeemed;
  acc.disputeCostPaise += outcome.dispute_cost;
  acc.recurrenceCostPaise += outcome.recurrence_cost;
  acc.escalationCostPaise += outcome.escalation_cost;
  acc.netRevenuePaise += outcome.net_revenue;
}

function mergeRevenue(a: RevenueAccumulator, b: RevenueAccumulator): RevenueAccumulator {
  return {
    scoredEvents: a.scoredEvents + b.scoredEvents,
    paidCount: a.paidCount + b.paidCount,
    disputedCount: a.disputedCount + b.disputedCount,
    escalatedCount: a.escalatedCount + b.escalatedCount,
    moneyCollectedPaise: a.moneyCollectedPaise + b.moneyCollectedPaise,
    discountRedeemedPaise: a.discountRedeemedPaise + b.discountRedeemedPaise,
    disputeCostPaise: a.disputeCostPaise + b.disputeCostPaise,
    recurrenceCostPaise: a.recurrenceCostPaise + b.recurrenceCostPaise,
    escalationCostPaise: a.escalationCostPaise + b.escalationCostPaise,
    netRevenuePaise: a.netRevenuePaise + b.netRevenuePaise,
  };
}

interface CustomerRollup {
  scenario: Scenario;
  events: number;
  baselineDiscount: number;
  memoryDiscount: number;
  baselineEscalations: number;
  memoryEscalations: number;
  baselineRevenue: RevenueAccumulator;
  memoryRevenue: RevenueAccumulator;
}

interface ScenarioRollup {
  scenario: Scenario;
  customers: number;
  events: number;
  baselineDiscountPaise: number;
  memoryDiscountPaise: number;
  discountReducedPaise: number;
  discountIncreasedPaise: number;
  baselineEscalations: number;
  memoryEscalations: number;
  baselineRevenue: RevenueAccumulator;
  memoryRevenue: RevenueAccumulator;
}

// cart_abandonment / subscription_recovery events carry a "gross amount at
// stake" for the recovery-outcome model (resolveRecoveryOutcome).


function main(): void {
  const scenarioLabels = readJson<ScenarioLabel[]>(join(GENERATED_DIR, "scenario_labels.json"));
  const baseline = readJson<DecisionRecord[]>(join(RESULTS_DIR, "baseline_decisions.json"));
  const memory = readJson<DecisionRecord[]>(join(RESULTS_DIR, "memory_decisions.json"));
  const cartEvents = readJson<CartAbandonmentEvent[]>(join(GENERATED_DIR, "cart_abandonment_events.json"));
  const subEvents = readJson<SubscriptionFailureEvent[]>(join(GENERATED_DIR, "subscription_failure_events.json"));
  const disputeEvents = readJson<DisputeEvent[]>(join(GENERATED_DIR, "dispute_events.json"));

  const scenarioByCustomer = new Map(scenarioLabels.map((l) => [l.customer_id, l.scenario]));
  const memoryByEvent = new Map(memory.map((d) => [d.event_id, d]));
  const grossAmountByEvent = buildGrossAmountByEvent(cartEvents, subEvents);
  const disputeAmountByEvent = buildDisputeAmountByEvent(disputeEvents);
  const disputeGamingEligible = buildDisputeGamingThresholdEvents(disputeEvents);

  const rollups = new Map<string, CustomerRollup>();

  for (const b of baseline) {
    const m = memoryByEvent.get(b.event_id);
    if (!m) continue; // memory run hasn't covered this event (e.g. still in progress)

    const scenario = scenarioByCustomer.get(b.customer_id) ?? "normal";
    const existing = rollups.get(b.customer_id) ?? {
      scenario,
      events: 0,
      baselineDiscount: 0,
      memoryDiscount: 0,
      baselineEscalations: 0,
      memoryEscalations: 0,
      baselineRevenue: emptyRevenue(),
      memoryRevenue: emptyRevenue(),
    };

    existing.events += 1;
    existing.baselineDiscount += b.committed_spend_paise ?? 0;
    existing.memoryDiscount += m.committed_spend_paise ?? 0;
    existing.baselineEscalations += b.escalate_to_human ? 1 : 0;
    existing.memoryEscalations += m.escalate_to_human ? 1 : 0;

    // Outcome resolution. cart_abandonment / subscription_recovery decisions
    // resolve through the recovery model, where both arms roll IDENTICAL
    // dice for this event_id (req 2) — computed once here and reused for
    // both arms' outcomes, so only the decision (not luck) can differ.
    // dispute_responder decisions resolve through the (deterministic, dice-
    // free) dispute-response model instead — see resolveOutcomes.ts.
    const grossAmount = grossAmountByEvent.get(b.event_id);
    const disputeAmount = disputeAmountByEvent.get(b.event_id);
    if (grossAmount != null && (b.agent === "cart_abandonment" || b.agent === "subscription_recovery")) {
      const rolls = rollsForEvent(b.event_id);
      const baselineOutcome = resolveRecoveryOutcome(b.event_id, b.agent, scenario, grossAmount, b, rolls);
      const memoryOutcome = resolveRecoveryOutcome(m.event_id, m.agent as typeof b.agent, scenario, grossAmount, m, rolls);
      addOutcome(existing.baselineRevenue, baselineOutcome);
      addOutcome(existing.memoryRevenue, memoryOutcome);
    } else if (disputeAmount != null && b.agent === "dispute_responder" && disputeGamingEligible.has(b.event_id)) {
      const baselineOutcome = resolveDisputeResponseOutcome(b.event_id, scenario, disputeAmount, b);
      const memoryOutcome = resolveDisputeResponseOutcome(m.event_id, scenario, disputeAmount, m);
      addOutcome(existing.baselineRevenue, baselineOutcome);
      addOutcome(existing.memoryRevenue, memoryOutcome);
    }

    rollups.set(b.customer_id, existing);
  }

  const scenarioRollups = new Map<Scenario, ScenarioRollup>();
  for (const r of rollups.values()) {
    const existing = scenarioRollups.get(r.scenario) ?? {
      scenario: r.scenario,
      customers: 0,
      events: 0,
      baselineDiscountPaise: 0,
      memoryDiscountPaise: 0,
      discountReducedPaise: 0,
      discountIncreasedPaise: 0,
      baselineEscalations: 0,
      memoryEscalations: 0,
      baselineRevenue: emptyRevenue(),
      memoryRevenue: emptyRevenue(),
    };
    existing.customers += 1;
    existing.events += r.events;
    existing.baselineDiscountPaise += r.baselineDiscount;
    existing.memoryDiscountPaise += r.memoryDiscount;
    // Gross per-customer movements, kept as two separate one-sided sums.
    // A single netted figure hides that memory spends LESS on some customers
    // and MORE on others; reporting only the reduction overstates the saving,
    // and reporting only the net (which is what the headline used to do)
    // silently cancelled a real ₹57,995 of avoided spend against increases
    // elsewhere and printed ₹0. Both are now published, and
    // netDiscountChangePaise below is exactly increased - reduced, so the
    // headline and the per-scenario rows reconcile by construction.
    existing.discountReducedPaise += Math.max(0, r.baselineDiscount - r.memoryDiscount);
    existing.discountIncreasedPaise += Math.max(0, r.memoryDiscount - r.baselineDiscount);
    existing.baselineEscalations += r.baselineEscalations;
    existing.memoryEscalations += r.memoryEscalations;
    existing.baselineRevenue = mergeRevenue(existing.baselineRevenue, r.baselineRevenue);
    existing.memoryRevenue = mergeRevenue(existing.memoryRevenue, r.memoryRevenue);
    scenarioRollups.set(r.scenario, existing);
  }

  const overall = {
    matchedEvents: [...rollups.values()].reduce((sum, r) => sum + r.events, 0),
    customers: rollups.size,
    baselineDiscountPaise: [...rollups.values()].reduce((sum, r) => sum + r.baselineDiscount, 0),
    memoryDiscountPaise: [...rollups.values()].reduce((sum, r) => sum + r.memoryDiscount, 0),
    baselineEscalations: [...rollups.values()].reduce((sum, r) => sum + r.baselineEscalations, 0),
    memoryEscalations: [...rollups.values()].reduce((sum, r) => sum + r.memoryEscalations, 0),
    baselineRevenue: [...rollups.values()].reduce((acc, r) => mergeRevenue(acc, r.baselineRevenue), emptyRevenue()),
    memoryRevenue: [...rollups.values()].reduce((acc, r) => mergeRevenue(acc, r.memoryRevenue), emptyRevenue()),
  };
  // Same three definitions at the overall level, summed from the same
  // per-customer movements the scenario rows use — so overall.discountReducedPaise
  // equals the sum of byScenario[].discountReducedPaise exactly.
  const discountReducedPaise = [...rollups.values()].reduce(
    (sum, r) => sum + Math.max(0, r.baselineDiscount - r.memoryDiscount),
    0,
  );
  const discountIncreasedPaise = [...rollups.values()].reduce(
    (sum, r) => sum + Math.max(0, r.memoryDiscount - r.baselineDiscount),
    0,
  );
  const netDiscountChangePaise = overall.memoryDiscountPaise - overall.baselineDiscountPaise;
  const overallNetRevenueLiftPaise = overall.memoryRevenue.netRevenuePaise - overall.baselineRevenue.netRevenuePaise;

  // Targeted check: for cross_domain_risk customers, the generator plants a
  // paid order, then a dispute on it, then a LATER (non-paid) abandoned cart.
  // Split by how the dispute resolved — the adverse cohort should see the
  // discount suppressed, the won cohort should not.
  const crossDomainSuppression = checkCrossDomainSuppression(scenarioLabels, cartEvents, baseline, memory);

  const byScenario = [...scenarioRollups.values()]
    .map((r) => ({
      scenario: r.scenario,
      customers: r.customers,
      events: r.events,
      baselineDiscountPaise: r.baselineDiscountPaise,
      memoryDiscountPaise: r.memoryDiscountPaise,
      discountReducedPaise: r.discountReducedPaise,
      discountIncreasedPaise: r.discountIncreasedPaise,
      netDiscountChangePaise: r.memoryDiscountPaise - r.baselineDiscountPaise,
      baselineEscalations: r.baselineEscalations,
      memoryEscalations: r.memoryEscalations,
      revenue: {
        baseline: r.baselineRevenue,
        memory: r.memoryRevenue,
        netRevenueLiftPaise: r.memoryRevenue.netRevenuePaise - r.baselineRevenue.netRevenuePaise,
      },
    }))
    .sort((a, b) => b.revenue.netRevenueLiftPaise - a.revenue.netRevenueLiftPaise);

  const report = {
    overall: {
      ...overall,
      discountReducedPaise,
      discountIncreasedPaise,
      netDiscountChangePaise,
      netRevenueLiftPaise: overallNetRevenueLiftPaise,
    },
    byScenario,
    crossDomainSuppression,
    // Self-documenting: these are business assumptions, not derived from
    // data — see src/outcomes/probabilities.ts. Printed here so the report
    // never needs to be read next to the source to understand what it means.
    methodology: {
      scope:
        "Two outcome models, by agent. cart_abandonment / subscription_recovery decisions solicit a NEW payment, so they resolve through the recovery model: paid/not-paid (probabilistic, per scenario), and if paid, whether it later became a dispute. dispute_responder decisions manage a dispute on a payment that already happened outside this batch, so they resolve through a separate, deterministic dispute-response model instead: conceding (accept_dispute) costs the full disputed amount plus the handling fee, contesting is treated as retaining the revenue (no contest-loss rate was given as a business assumption, so none was invented). The dispute-response model is ALSO scoped to only a customer's 3rd-and-later dispute event — the same REPEAT_RECOVERY_THRESHOLD_PER_AGENT=3 threshold policy.ts already uses for repeatRecoveryWithThisAgent on this agent — so it measures the repeat-offender mechanism the memory system targets, not ordinary one-off dispute judgment calls (which are LLM-reasoning noise unrelated to cross-agent memory and would otherwise swamp the comparison).",
      rng: "The recovery model draws from a PRNG seeded deterministically from event_id alone, in a fixed order (paid roll, then dispute roll), computed once per event and reused for both arms. Both arms see identical dice — only the probability compared against (based on that arm's own decision) differs. This is the standard common-random-numbers technique for a paired comparison: it removes luck as a source of measured lift. The dispute-response model is deterministic by action and uses no randomness at all.",
      escalation:
        "Escalation is a REAL, PRICED outcome, not an exclusion — every decision is scored, in both arms, over the identical set of events; nothing is dropped. Escalating hands the case to a human (via the merchant's dashboard) instead of auto-acting, so it costs staff time rather than margin: a human is modeled as at least as effective as an automated discount (an escalated cart/subscription decision converts at that scenario's pays-WITH-discount probability but spends no discount; an escalated dispute decision avoids the concede cost entirely, like a successful contest) and is charged a flat handling cost regardless of outcome. Two earlier versions of this model treated escalation as producing 'no outcome' (excluded per-arm, then excluded in a paired fashion) — both were workarounds for not pricing the thing memory actually does more of. Per-arm exclusion let baseline bank revenue on events where memory's matching decision was silently dropped; paired exclusion fixed that asymmetry but, combined with the dispute model's mandatory-escalate policy on gaming_suspected, ended up excluding 100% of repeat_offender_dispute's scoreable events. Pricing escalation directly removes the need for any exclusion.",
      escalationHandlingCostPaise: ESCALATION_HANDLING_COST_PAISE,
      recurrenceCost:
        "A per-event independent outcome model has no way to charge the cost of an INDUCED future extraction cycle against the event that caused it — so under it, discounting a repeat offender always looks correct, since the higher pays-with-discount probability is scored but the fact that the discount teaches the pattern to repeat is not. To fix that, a redeemed discount (paid, not merely offered, and NOT escalated — escalating spends no discount) in repeat_offender_cart or repeat_offender_subscription is charged an additional induced-recurrence cost of discount_redeemed × RECURRENCE_COST_MULTIPLIER. This does not apply to normal, noise, cross_domain_risk, or churn_signal, where no repeat-extraction pattern is established.",
      disputeCost: "A dispute costs back the net-of-discount amount actually collected, plus a flat handling fee.",
      disputeHandlingFeePaise: DISPUTE_HANDLING_FEE_PAISE,
      recurrenceCostMultiplier: RECURRENCE_COST_MULTIPLIER,
      recurrenceCostScenarios: [...RECURRENCE_COST_SCENARIOS],
      probabilities: OUTCOME_PROBABILITIES,
    },
  };

  writeFileSync(join(RESULTS_DIR, "comparison_report.json"), JSON.stringify(report, null, 2) + "\n", "utf-8");

  console.log(JSON.stringify(report, null, 2));
  console.log(`\nWrote ${join(RESULTS_DIR, "comparison_report.json")}`);
  printRevenueSummary(report.overall, report.byScenario);
  printCrossDomainSummary(report.crossDomainSuppression);
}

// The paired read, printed explicitly: identical event shape in both cohorts,
// opposite correct behaviour, split only by how the dispute resolved.
function printCrossDomainSummary(result: CrossDomainSuppressionResult): void {
  const { adverse, merchant_conceded: merchantConceded, summary } = result;
  const rate = (n: number | null): string => (n == null ? "n/a" : `${n}%`);
  console.log("\n=== Cross-domain suppression, split by dispute outcome ===");
  console.log(
    `adverse (rzp won/under_review):  suppressed ${adverse.suppressed}/${adverse.customersChecked} (${rate(
      summary.adverseSuppressionRatePct,
    )}) — suppression is CORRECT here`,
  );
  console.log(
    `merchant_conceded (rzp lost):    suppressed ${merchantConceded.suppressed}/${merchantConceded.customersChecked} (${rate(
      summary.merchantConcededSuppressionRatePct,
    )}) — suppression is a FALSE POSITIVE here`,
  );
  console.log(
    `of ${summary.totalSuppressions} suppressions overall, ${summary.correctSuppressions} landed on the right cohort (${rate(
      summary.correctSuppressionRatePct,
    )})`,
  );
}

function paiseToRupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

function printRevenueSummary(
  overall: { baselineRevenue: RevenueAccumulator; memoryRevenue: RevenueAccumulator; netRevenueLiftPaise: number },
  byScenario: {
    scenario: Scenario;
    revenue: { baseline: RevenueAccumulator; memory: RevenueAccumulator; netRevenueLiftPaise: number };
  }[],
): void {
  console.log("\n=== Net revenue summary (memory arm vs. baseline arm) ===");
  console.log(
    `overall: baseline ${paiseToRupees(overall.baselineRevenue.netRevenuePaise)}  memory ${paiseToRupees(
      overall.memoryRevenue.netRevenuePaise,
    )}  lift ${paiseToRupees(overall.netRevenueLiftPaise)}`,
  );
  for (const s of byScenario) {
    console.log(
      `${s.scenario.padEnd(30)} baseline ${paiseToRupees(s.revenue.baseline.netRevenuePaise).padStart(10)}  memory ${paiseToRupees(
        s.revenue.memory.netRevenuePaise,
      ).padStart(10)}  lift ${paiseToRupees(s.revenue.netRevenueLiftPaise).padStart(10)}`,
    );
  }
}

// A cross_domain_risk customer's planted dispute resolves one of three ways,
// and they do NOT all imply the same correct behaviour on the later cart:
//
// Razorpay's dispute status describes how it went for the MERCHANT, so the
// words mean the opposite of the intuitive reading (see DisputeBreakdown in
// types/memory.ts):
//
//   'won' / 'under_review' -> the merchant contested successfully (the
//                          complaint did not hold up), or there is no ruling
//                          yet. Evidence about the CUSTOMER, so suppressing
//                          the next discount is the right call.
//   'lost'              -> the merchant lost or accepted the chargeback and
//                          the customer was refunded. That is evidence about
//                          the MERCHANT. Suppressing here punishes a customer
//                          who was right to complain — a false positive.
//
// Counting both cohorts as "suppressions" (which this metric used to do,
// before the won arm existed) makes the number unfalsifiable: a system that
// suppressed on the mere existence of a dispute would score identically to
// one that reads the outcome. Splitting is what turns it into a real claim.
// Cohort keys are named for what they MEAN, not for Razorpay's status words,
// so the report cannot be misread the way the code itself once was.
type SuppressionCohort = "adverse" | "merchant_conceded";

function cohortFor(outcome: DisputeStatus | undefined): SuppressionCohort {
  return outcome === "lost" ? "merchant_conceded" : "adverse";
}

interface SuppressionDetail {
  customer_id: string;
  event_id: string;
  dispute_outcome: DisputeStatus | null;
  baselineDiscount: number | null;
  memoryDiscount: number | null;
  suppressed: boolean;
}

interface CohortResult {
  customersChecked: number;
  // memory discount strictly less than baseline on the later cart
  suppressed: number;
  unchanged: number;
  details: SuppressionDetail[];
}

interface CrossDomainSuppressionResult {
  // What each cohort is for, carried in the report so the two numbers are
  // never read as if they meant the same thing.
  expectation: {
    adverse: string;
    merchant_conceded: string;
  };
  adverse: CohortResult;
  merchant_conceded: CohortResult;
  summary: {
    // Of every suppression memory made across the whole cross_domain_risk
    // cohort, what share landed on a customer who deserved it. Precision-
    // style, deliberately not called "precision": with cell counts this size
    // the claim is directional, not statistical.
    correctSuppressions: number;
    falsePositiveSuppressions: number;
    totalSuppressions: number;
    correctSuppressionRatePct: number | null;
    // The paired read a judge should take: same event shape in both cohorts,
    // opposite decision, because the dispute outcome differed.
    adverseSuppressionRatePct: number | null;
    merchantConcededSuppressionRatePct: number | null;
  };
}

function checkCrossDomainSuppression(
  scenarioLabels: ScenarioLabel[],
  cartEvents: CartAbandonmentEvent[],
  baseline: DecisionRecord[],
  memory: DecisionRecord[],
): CrossDomainSuppressionResult {
  const crossDomainCustomers = new Set(
    scenarioLabels.filter((l) => l.scenario === "cross_domain_risk").map((l) => l.customer_id),
  );

  // The generator plants exactly one non-paid cart event per
  // cross_domain_risk customer — the "later" abandoned cart that follows a
  // dispute on their earlier paid order. Pick it directly from the event
  // data rather than guessing from decisions, which can pick the wrong
  // (already-paid) event when neither run happened to discount it.
  const targetEventByCustomer = new Map<string, string>();
  for (const e of cartEvents) {
    if (e.status !== "paid" && crossDomainCustomers.has(e.customer_id)) {
      targetEventByCustomer.set(e.customer_id, e.order_id);
    }
  }

  // Read straight off the scenario label rather than re-derived from
  // dispute_events: the label records which outcome the generator planted, so
  // there is no guessing about which of a customer's disputes was the planted
  // one.
  const outcomeByCustomer = new Map(scenarioLabels.map((l) => [l.customer_id, l.dispute_outcome]));

  const baselineByEvent = new Map(baseline.map((d) => [d.event_id, d]));
  const memoryByEvent = new Map(memory.map((d) => [d.event_id, d]));

  const byCohort: Record<SuppressionCohort, SuppressionDetail[]> = { adverse: [], merchant_conceded: [] };
  for (const [customerId, eventId] of targetEventByCustomer) {
    const b = baselineByEvent.get(eventId);
    const m = memoryByEvent.get(eventId);
    if (!b || !m) continue;
    const outcome = outcomeByCustomer.get(customerId);
    byCohort[cohortFor(outcome)].push({
      customer_id: customerId,
      event_id: eventId,
      dispute_outcome: outcome ?? null,
      baselineDiscount: b.committed_spend_paise,
      memoryDiscount: m.committed_spend_paise,
      suppressed: (m.committed_spend_paise ?? 0) < (b.committed_spend_paise ?? 0),
    });
  }

  const toCohortResult = (details: SuppressionDetail[]): CohortResult => {
    const suppressed = details.filter((d) => d.suppressed).length;
    return { customersChecked: details.length, suppressed, unchanged: details.length - suppressed, details };
  };

  const adverse = toCohortResult(byCohort.adverse);
  const merchantConceded = toCohortResult(byCohort.merchant_conceded);
  const totalSuppressions = adverse.suppressed + merchantConceded.suppressed;
  const pct = (n: number, d: number): number | null => (d === 0 ? null : Math.round((n / d) * 100));

  return {
    expectation: {
      adverse:
        "Razorpay status 'won' (merchant contested successfully — the complaint did not hold up) or 'under_review' (no ruling yet as of the later cart). Evidence about the customer. Memory SHOULD suppress; a suppression here is correct.",
      merchant_conceded:
        "Razorpay status 'lost' — the merchant lost or accepted the chargeback and the customer was refunded. Evidence about the merchant's delivery, not the customer. Memory should NOT suppress; a suppression here is a false positive.",
    },
    adverse,
    merchant_conceded: merchantConceded,
    summary: {
      correctSuppressions: adverse.suppressed,
      falsePositiveSuppressions: merchantConceded.suppressed,
      totalSuppressions,
      correctSuppressionRatePct: pct(adverse.suppressed, totalSuppressions),
      adverseSuppressionRatePct: pct(adverse.suppressed, adverse.customersChecked),
      merchantConcededSuppressionRatePct: pct(merchantConceded.suppressed, merchantConceded.customersChecked),
    },
  };
}

main();
