import type { Scenario } from "../data/generator.js";
import { hashStringToSeed } from "../lib/hash.js";
import { createRng } from "../lib/rng.js";
import type { AgentType } from "../types/index.js";
import {
  DISPUTE_HANDLING_FEE_PAISE,
  ESCALATION_HANDLING_COST_PAISE,
  OUTCOME_PROBABILITIES,
  RECURRENCE_COST_MULTIPLIER,
  RECURRENCE_COST_SCENARIOS,
} from "./probabilities.js";

export interface DecisionInput {
  discount_amount: number | null;
  escalate_to_human: boolean;
}

// Source-agnostic outcome columns. Every decision is scored — escalation is
// priced as a real outcome (see escalation_cost), not excluded. These same
// fields are what a real `payment.captured` / refund webhook would populate
// in production — the comparison code downstream doesn't know or care that
// today they came from a synthetic dice roll instead.
export interface DecisionOutcome {
  event_id: string;
  agent: AgentType;
  scenario: Scenario;
  paid: boolean | null; // null only for dispute_responder, where "paid" doesn't apply
  money_collected: number; // paise; gross_amount if paid, else 0
  discount_redeemed: number; // paise; cost of the discount — 0 unless paid AND not escalated (req 3)
  disputed: boolean;
  dispute_cost: number; // paise; refunded net-of-discount amount + flat fee, 0 unless disputed
  // paise; induced-recurrence cost (RECURRENCE_COST_MULTIPLIER × discount
  // redeemed) — only nonzero for a redeemed discount in
  // RECURRENCE_COST_SCENARIOS. Naturally 0 when escalated, since escalating
  // spends no discount and so teaches no extraction pattern.
  recurrence_cost: number;
  // paise; flat handling cost charged whenever this decision escalated —
  // see ESCALATION_HANDLING_COST_PAISE.
  escalation_cost: number;
  net_revenue: number; // paise; money_collected - discount_redeemed - dispute_cost - recurrence_cost - escalation_cost
}

// The escalation model is the single most load-bearing assumption in this
// scoring layer, and the most attackable: the default makes escalation
// strictly dominant (a discount's conversion for a flat fee and no margin
// spent), and the memory arm escalates roughly ten times as often as
// baseline. Parameterising it lets the same recorded decisions be re-scored
// under alternative assumptions without re-running a batch, so the claim can
// be tested rather than argued about. See analysis/escalationSensitivity.ts.
export interface EscalationModel {
  // Which pay probability an escalated RECOVERY decision draws against.
  // "with_discount" models a human as at least as effective as an automated
  // discount; "without_discount" models human outreach as adding nothing
  // over doing nothing. Has no meaning for dispute decisions, which have no
  // pays/not-pays outcome.
  convertsAt: "with_discount" | "without_discount";
  // Flat cost charged whenever a decision escalates, in either model.
  handlingCostPaise: number;
}

export const DEFAULT_ESCALATION_MODEL: EscalationModel = {
  convertsAt: "with_discount",
  handlingCostPaise: ESCALATION_HANDLING_COST_PAISE,
};

export interface EventRolls {
  paidRoll: number;
  disputeRoll: number;
}

// Seeded from event_id ALONE, drawn in a fixed order (paid roll, then
// dispute roll). Call this once per event and reuse the same rolls for both
// arms (req 2) — only the probability each arm's decision is compared
// against should differ, never the dice themselves.
export function rollsForEvent(eventId: string): EventRolls {
  const rng = createRng(hashStringToSeed(eventId));
  return { paidRoll: rng.next(), disputeRoll: rng.next() };
}

// For cart_abandonment / subscription_recovery decisions: resolves whether
// this recovery attempt was paid, and — if paid — whether it later became a
// dispute. See probabilities.ts for the given business assumptions.
//
// Escalation is a real, priced outcome, not an exclusion: a human reaches
// out instead of an automated discount, so it converts at the scenario's
// pays-WITH-discount probability (a human is modeled as at least as
// effective as a discount) but spends no discount — only the flat
// escalation handling cost applies, charged regardless of whether the
// human's outreach converted.
export function resolveRecoveryOutcome(
  eventId: string,
  agent: "cart_abandonment" | "subscription_recovery",
  scenario: Scenario,
  grossAmount: number,
  decision: DecisionInput,
  rolls: EventRolls,
  escalationModel: EscalationModel = DEFAULT_ESCALATION_MODEL,
): DecisionOutcome {
  const probs = OUTCOME_PROBABILITIES[scenario];
  const escalated = decision.escalate_to_human;
  const hasDiscount = !escalated && decision.discount_amount != null;
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
      agent,
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

  const discountRedeemed = hasDiscount ? (decision.discount_amount as number) : 0;
  const netAmountPaid = grossAmount - discountRedeemed;
  const disputed = rolls.disputeRoll < probs.disputesGivenPaid;
  const disputeCost = disputed ? netAmountPaid + DISPUTE_HANDLING_FEE_PAISE : 0;
  const recurrenceCost =
    discountRedeemed > 0 && RECURRENCE_COST_SCENARIOS.has(scenario)
      ? Math.round(discountRedeemed * RECURRENCE_COST_MULTIPLIER)
      : 0;
  const netRevenue = grossAmount - discountRedeemed - disputeCost - recurrenceCost - escalationCost;

  return {
    event_id: eventId,
    agent,
    scenario,
    paid: true,
    money_collected: grossAmount,
    discount_redeemed: discountRedeemed,
    disputed,
    dispute_cost: disputeCost,
    recurrence_cost: recurrenceCost,
    escalation_cost: escalationCost,
    net_revenue: netRevenue,
  };
}

// For dispute_responder decisions: the underlying payment already happened
// in the past — outside this batch's recovery decisions — so there's no
// "paid" outcome to resolve here, only whether THIS dispute costs money.
//
// Concede/contest is deterministic by action, ratified as-is: conceding
// (accept_dispute) costs the full disputed amount plus the flat handling
// fee; contesting is treated as retaining the revenue (no contest-loss rate
// was given as a business assumption, so none was invented). Escalation is
// now a real, priced outcome instead of an exclusion: a human contests
// properly instead of auto-conceding, so it avoids the concede cost
// entirely — but, like any escalation, it still costs the flat handling fee.
export function resolveDisputeResponseOutcome(
  eventId: string,
  scenario: Scenario,
  disputeAmount: number,
  decision: { action: string; escalate_to_human: boolean },
  escalationModel: EscalationModel = DEFAULT_ESCALATION_MODEL,
): DecisionOutcome {
  const escalated = decision.escalate_to_human;
  const conceded = !escalated && decision.action === "accept_dispute";
  const disputeCost = conceded ? disputeAmount + DISPUTE_HANDLING_FEE_PAISE : 0;
  // Only handlingCostPaise applies here — convertsAt has no meaning for a
  // dispute decision, which resolves deterministically by action.
  const escalationCost = escalated ? escalationModel.handlingCostPaise : 0;

  return {
    event_id: eventId,
    agent: "dispute_responder",
    scenario,
    paid: null,
    money_collected: 0,
    discount_redeemed: 0,
    disputed: true,
    dispute_cost: disputeCost,
    recurrence_cost: 0,
    escalation_cost: escalationCost,
    net_revenue: -disputeCost - escalationCost,
  };
}
