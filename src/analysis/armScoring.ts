// Scores a recovery decision under a given set of outcome probabilities.
//
// This is the same arithmetic as resolveRecoveryOutcome (src/outcomes/resolveOutcomes.ts),
// with the probabilities passed in instead of read from OUTCOME_PROBABILITIES. The
// sensitivity analysis needs that: it re-scores stored decisions under scaled lifts,
// and probabilities.ts must not change. A test pins this copy to the real resolver
// on random inputs, so the two cannot drift apart silently.
import {
  DISPUTE_HANDLING_FEE_PAISE,
  RECURRENCE_COST_MULTIPLIER,
  RECURRENCE_COST_SCENARIOS,
  OUTCOME_PROBABILITIES,
  type ScenarioOutcomeProbabilities,
} from "../outcomes/probabilities.js";
import {
  DEFAULT_ESCALATION_MODEL,
  type DecisionOutcome,
  type DecisionInput,
  type EventRolls,
} from "../outcomes/resolveOutcomes.js";
import type { Scenario } from "../data/generator.js";

export interface ScoreInput {
  eventId: string;
  scenario: Scenario;
  grossAmount: number;
  decision: DecisionInput;
  rolls: EventRolls;
  probs: ScenarioOutcomeProbabilities;
}

export function scoreWithProbs(input: ScoreInput): DecisionOutcome {
  const { eventId, scenario, grossAmount, decision, rolls, probs } = input;
  const escalationModel = DEFAULT_ESCALATION_MODEL;
  const escalated = decision.escalate_to_human;
  const hasDiscount = !escalated && decision.committed_spend_paise != null;
  const escalatedPayProbability =
    escalationModel.convertsAt === "with_discount" ? probs.paysWithDiscount : probs.paysWithoutDiscount;
  const payProbability = escalated
    ? escalatedPayProbability
    : hasDiscount
      ? probs.paysWithDiscount
      : probs.paysWithoutDiscount;
  const paid = rolls.paidRoll < payProbability;
  const escalationCost = escalated ? escalationModel.handlingCostPaise : 0;

  if (!paid) {
    return {
      event_id: eventId,
      agent: "cart_abandonment",
      scenario,
      paid: false,
      money_collected: 0,
      discount_redeemed: 0,
      disputed: false,
      dispute_cost: 0,
      recurrence_cost: 0,
      escalation_cost: escalationCost,
      net_revenue: -escalationCost,
    };
  }

  const discountRedeemed = hasDiscount ? (decision.committed_spend_paise as number) : 0;
  const netAmountPaid = grossAmount - discountRedeemed;
  const disputed = rolls.disputeRoll < probs.disputesGivenPaid;
  const disputeCost = disputed ? netAmountPaid + DISPUTE_HANDLING_FEE_PAISE : 0;
  const recurrenceCost =
    discountRedeemed > 0 && RECURRENCE_COST_SCENARIOS.has(scenario)
      ? Math.round(discountRedeemed * RECURRENCE_COST_MULTIPLIER)
      : 0;
  return {
    event_id: eventId,
    agent: "cart_abandonment",
    scenario,
    paid: true,
    money_collected: grossAmount,
    discount_redeemed: discountRedeemed,
    disputed,
    dispute_cost: disputeCost,
    recurrence_cost: recurrenceCost,
    escalation_cost: escalationCost,
    net_revenue: grossAmount - discountRedeemed - disputeCost - recurrenceCost - escalationCost,
  };
}

// The published probabilities for a scenario, unchanged.
export function publishedProbs(scenario: Scenario): ScenarioOutcomeProbabilities {
  return OUTCOME_PROBABILITIES[scenario];
}

// Scale only the lift, the difference between paying with and without a discount,
// by k. Clamped to [0, 1]. k = 1 returns the published values exactly.
export function scaleLift(probs: ScenarioOutcomeProbabilities, k: number): ScenarioOutcomeProbabilities {
  const lift = probs.paysWithDiscount - probs.paysWithoutDiscount;
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  return {
    paysWithoutDiscount: probs.paysWithoutDiscount,
    paysWithDiscount: clamp(probs.paysWithoutDiscount + k * lift),
    disputesGivenPaid: probs.disputesGivenPaid,
  };
}
