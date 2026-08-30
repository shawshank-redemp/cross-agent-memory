import type { Scenario } from "../data/generator.js";

// Business assumptions for the synthetic outcome model. These are NOT
// derived from data — they're given, kept in one place so they're easy to
// audit and edit, and printed into the comparison report so the report is
// self-documenting (see compareRuns.ts's `methodology` block).
//
// Per scenario: the chance a customer pays if offered a discount, the
// chance they pay anyway with no discount, and — given they paid — the
// chance that payment later becomes a dispute.
export interface ScenarioOutcomeProbabilities {
  paysWithDiscount: number;
  paysWithoutDiscount: number;
  disputesGivenPaid: number;
}

export const OUTCOME_PROBABILITIES: Record<Scenario, ScenarioOutcomeProbabilities> = {
  normal: { paysWithDiscount: 0.6, paysWithoutDiscount: 0.35, disputesGivenPaid: 0.02 },
  repeat_offender_cart: { paysWithDiscount: 0.8, paysWithoutDiscount: 0.3, disputesGivenPaid: 0.05 },
  repeat_offender_subscription: { paysWithDiscount: 0.75, paysWithoutDiscount: 0.4, disputesGivenPaid: 0.05 },
  repeat_offender_dispute: { paysWithDiscount: 0.55, paysWithoutDiscount: 0.3, disputesGivenPaid: 0.4 },
  cross_domain_risk: { paysWithDiscount: 0.55, paysWithoutDiscount: 0.3, disputesGivenPaid: 0.35 },
  churn_signal: { paysWithDiscount: 0.3, paysWithoutDiscount: 0.15, disputesGivenPaid: 0.05 },
  // An established payer who abandoned once. The high paysWithoutDiscount is the
  // whole point of the cohort: they largely convert on their own, so margin
  // spent here is largely margin wasted — which is the tension the accelerator
  // creates and the reason provenPayer widens a cap rather than forcing a spend.
  loyal_payer: { paysWithDiscount: 0.7, paysWithoutDiscount: 0.55, disputesGivenPaid: 0.02 },
  // Heavy abandoner who also genuinely pays: responds to discounts like a
  // repeat abandoner, but converts unaided more often than one, because some of
  // the abandonment is real.
  conflicted_customer: { paysWithDiscount: 0.78, paysWithoutDiscount: 0.34, disputesGivenPaid: 0.05 },
  // Extraction spread thin across three agents. Same discount-responsiveness as
  // the single-agent repeat abandoner — the pattern is identical, only the
  // distribution across agents differs — with a higher dispute rate, since this
  // cohort files one by construction.
  cross_agent_gaming: { paysWithDiscount: 0.8, paysWithoutDiscount: 0.3, disputesGivenPaid: 0.08 },
  noise: { paysWithDiscount: 0.4, paysWithoutDiscount: 0.25, disputesGivenPaid: 0.05 },
};

// A dispute costs back the refunded (net-of-discount) revenue plus this flat
// handling fee.
export const DISPUTE_HANDLING_FEE_PAISE = 150_000; // ₹1,500

// Business assumption: a successful discount (paid, not merely offered) to
// a customer with an ALREADY-ESTABLISHED extraction pattern buys one
// conversion now, but reliably induces further extraction cycles later —
// the discount is what taught them the pattern works. Per-event independent
// scoring has no way to charge that induced future cost against the event
// that caused it, so this multiplier is the modeled expected cost of those
// induced cycles, charged against the event where the discount was actually
// redeemed. This is a single, deliberately editable business assumption —
// not tuned to produce a particular result (see resolveOutcomes.ts).
export const RECURRENCE_COST_MULTIPLIER = 1.5;

// Scoped to exactly the two scenarios where a repeat-extraction pattern is
// established BY DEFINITION (see generator.ts's generateRepeatOffenderCart /
// generateRepeatOffenderSubscription). Must never include normal, noise,
// cross_domain_risk, or churn_signal — a customer there hasn't demonstrated
// a pattern, so there's no induced-recurrence cost to charge.
//
// OPEN QUESTION, deliberately left alone: cross_agent_gaming and
// conflicted_customer also establish an extraction pattern by definition, so
// they arguably belong here too. Adding them would change the scoring model
// rather than the data, so it is a pricing decision to make on its own
// evidence — not something to fold into a generator change.
export const RECURRENCE_COST_SCENARIOS: ReadonlySet<Scenario> = new Set<Scenario>([
  "repeat_offender_cart",
  "repeat_offender_subscription",
]);

// Business assumption: escalating hands the case to a human instead of
// auto-acting — it is a real, priced outcome, not "no outcome." A human is
// modeled as at least as effective as an automated discount (converts at
// the scenario's pays-WITH-discount probability for a recovery decision, or
// avoids the concede cost entirely for a dispute decision) and costs
// merchant staff time rather than margin: this flat handling cost, charged
// whenever a decision escalates, regardless of agent or arm.
export const ESCALATION_HANDLING_COST_PAISE = 30_000; // ₹300
