import { PROFILE_RECENT_EVENTS_LOOKBACK_DAYS } from "../../memory/profile.js";
import type { DisputeCautionLevel } from "./types.js";

// ---------------------------------------------------------------------------
// REPEAT RECOVERY: how often the customer has come back through a recovery flow
// ---------------------------------------------------------------------------
//
// These count EVENTS THE CUSTOMER HAD, not discounts we gave. That distinction
// used to be lost: one constant (MAX_DISCOUNT_ATTEMPTS_PER_AGENT) gated both
// the repeat-event rule and the already-spent rule, so a single number meant
// two unrelated things. They are separate constants now.
//
// The old signal reading these was called `gamingSuspected` and its prompt text
// accused the customer of farming discounts. It counted events, so a customer
// who abandoned three carts and was never offered anything was flagged as a
// discount farmer — and you cannot farm a discount you were never given. The
// signal is renamed to what it measures and its effect is downgraded from
// "block and escalate" to "tighten the ceiling": repeatedly failing to complete
// a purchase is a reason for caution, not proof of abuse.
export const REPEAT_RECOVERY_THRESHOLD_PER_AGENT = 3;

// Spreading triggers across agents rather than repeating one is the same shape
// from a different angle, and no per-agent count would ever reach its own
// threshold. Deliberately a different number so the two are distinguishable as
// separate causes in the audit log.
export const REPEAT_RECOVERY_THRESHOLD_ACROSS_AGENTS = 5;

// How far back the repeat-recovery counts look.
//
// MEASURED, so the effect of adding this is not overstated: on the committed
// batch it moves the per-agent rule from 31.8% to 31.6% of decisions and the
// cross-agent rule from 12.7% to 10.8%. The batch only spans ~120 days, so
// "ever" and "last 90 days" are nearly the same population here. The window is
// still correct — in production, history runs for years and an unbounded count
// never forgets — but it is a production-correctness fix, not a lever on this
// batch's numbers.
//
// 90 rather than 120: a 120-day window would cover the entire batch, making it
// indistinguishable from having no window at all, and it would exceed the
// profile's 90-day storage bound asserted below.
export const REPEAT_RECOVERY_LOOKBACK_DAYS = 90;

// The ceiling a repeat pattern permits. Below the default, above the levels
// that indicate actual fault.
export const REPEAT_RECOVERY_DISCOUNT_CAP_PERCENT = 15;

// ---------------------------------------------------------------------------
// SPEND LIMITS: how much margin we have already committed
// ---------------------------------------------------------------------------
//
// These count DISCOUNTS WE GAVE. See the note above on why they no longer
// share a constant with the repeat-event rules.
export const MAX_DISCOUNTS_PER_AGENT = 3;
export const DISCOUNT_HISTORY_LOOKBACK_DAYS = 90;

// CROSS-AGENT SPEND CEILING — the hole this closes:
//
// MAX_DISCOUNTS_PER_AGENT is per agent, so Cart could grant 2, Subscription 2
// and Dispute 2 — six discounts to one customer, each up to a fifth of the
// order — without any agent reaching its own limit of 3 and without any signal
// firing. The old crossAgentGamingSuspected sounded like it covered this and
// did not: it counted the customer's EVENTS, never our SPEND, so six discounts
// across three agents were invisible to it.
//
// Expressed as a share of what the customer has actually paid us, because a
// flat rupee cap treats a customer who has spent lakhs the same as one who has
// spent nothing. The floor exists because 39.5% of decisions in this batch
// involve a customer who has paid us NOTHING — a pure percentage rule would set
// their limit to zero and block every discount to every new customer, which is
// the opposite of what a recovery system is for. The floor is roughly one
// discount on a median order (median cart ~₹2,700, so 20% is ~₹540).
export const CROSS_AGENT_SPEND_FLOOR_PAISE = 75_000; // ₹750
export const CROSS_AGENT_SPEND_SHARE_OF_LIFETIME_PAID = 0.25;

// How many discounts must have been granted, and converted none, before we
// conclude discounting does not work on this customer. Two is enough evidence
// to stop; one is a coincidence.
export const INEFFECTIVE_DISCOUNT_MIN_ATTEMPTS = 2;

// ---------------------------------------------------------------------------
// CHURN
// ---------------------------------------------------------------------------
//
// This replaced a window-pair rule that compared each agent's AGGREGATE window
// (first event to last event) and fired when two windows came within 14 days
// of each other. That was wrong twice over: a window can span months, so two
// events 36 days apart could satisfy "within 14 days"; and nothing aged out,
// so a bad fortnight eight months ago still tripped the signal today.
export const CHURN_LOOKBACK_DAYS = 14;

// The profile's storage bound must be at least as wide as every policy
// lookback that reads recent_events, or the policy silently sees a truncated
// history and under-fires. Asserted at module load rather than left as a
// comment, because the constants live in different files.
for (const [name, days] of [
  ["CHURN_LOOKBACK_DAYS", CHURN_LOOKBACK_DAYS],
  ["REPEAT_RECOVERY_LOOKBACK_DAYS", REPEAT_RECOVERY_LOOKBACK_DAYS],
  ["DISCOUNT_HISTORY_LOOKBACK_DAYS", DISCOUNT_HISTORY_LOOKBACK_DAYS],
] as const) {
  if (days > PROFILE_RECENT_EVENTS_LOOKBACK_DAYS) {
    throw new Error(
      `${name} (${days}) exceeds PROFILE_RECENT_EVENTS_LOOKBACK_DAYS ` +
        `(${PROFILE_RECENT_EVENTS_LOOKBACK_DAYS}): the profile would be truncated below what this rule needs.`,
    );
  }
}

// ---------------------------------------------------------------------------
// ESCALATION
// ---------------------------------------------------------------------------
//
// A human handoff is only worth making when the amount at stake justifies the
// person's time. Nothing used to ask that question, and measured on the batch
// the system was escalating a ₹199 abandoned cart: a quarter of all forced
// escalations were on events worth under ₹1,000, against a modelled review cost
// of ₹300. For those the review costs a meaningful fraction of the thing being
// recovered, and sometimes more than it.
//
// Set at roughly 6.7x the modelled handling cost, so a recovery has to be worth
// clearly more than the review it triggers. Measured effect: forced escalation
// falls from 7.6% to 4.0% of decisions, and it cuts cart abandonment hardest
// (median cart at stake ₹2,600) while leaving dispute_responder proportionally
// higher — which is correct, since conceding a dispute forfeits the full amount.
//
// This is a FLOOR ON THE EFFECT, not on the signal. recentMultiDomainTrouble
// still computes and still reports as a fact about the customer; what the amount
// gates is whether policy turns that fact into a person's time.
export const ESCALATION_MIN_EVENT_AMOUNT_PAISE = 200_000; // ₹2,000

// ---------------------------------------------------------------------------
// PROVEN PAYER — the one accelerator
// ---------------------------------------------------------------------------
//
// TWO conditions, not one. The count alone was the whole test, and measured on
// the batch that meant the 180 customers who qualified had lifetime spend
// ranging from ₹398 to ₹14,298 — a 36x spread all granted the identical extra
// margin. A count says whether they have paid; only an amount says whether it
// was worth anything.
//
// ₹2,500 sits near the 75th percentile of lifetime spend at decision time
// (median ₹499, p75 ₹2,495), so the accelerator now means roughly "the top
// quarter of customers by value" rather than "has paid twice".
//
// This absorbs what would otherwise have been a second `highValueCustomer`
// signal. Two accelerators reading the same two facts and both widening the
// same ceiling is duplication, not nuance.
export const MIN_SUCCESSFUL_PAYMENTS = 2;
export const MIN_LIFETIME_PAID_PAISE = 250_000; // ₹2,500

// ---------------------------------------------------------------------------
// ABSOLUTE BOUNDS — the limits nothing may cross
// ---------------------------------------------------------------------------
//
// Everything else in this file is a PERCENTAGE of an event amount, which means
// every limit scales with a number the agent does not control. These three are
// the only absolute ones, and they exist because a percentage cannot bound
// anything on its own.
//
// All three are UNIVERSAL: they apply to both arms identically, like the rest of
// the universal policy layer. A bound that applied to one arm only would make
// any measured difference partly the bound's doing rather than memory's — the
// same confound the universal layer was introduced to remove.

// No resolved cap may exceed this, whatever a signal declares.
//
// resolveSignalEffects takes the MINIMUM across brakes, so brakes are already
// bounded below. Accelerators are not bounded above at all: provenPayer sets 25%
// today, and a signal registered tomorrow declaring 60% would simply get 60%.
// The "universal" default of 20% is a FALLBACK, not a maximum, so nothing in the
// system currently says how wide is too wide. This does.
export const MAX_DISCOUNT_CAP_PERCENT = 25;

// No single discount may exceed this, whatever the percentage works out to.
//
// A percentage of an arbitrary order is not a bound. At the batch's largest cart
// (₹5,000) the widest ceiling yields ₹1,250, so THIS LIMIT DOES NOT BIND HERE —
// and that is the correct state for a safety limit rather than a defect in it.
// It exists because the rule is a share of a number nobody bounded: a ₹5,00,000
// order would otherwise authorise ₹1,25,000 with no human involved.
export const MAX_SINGLE_DISCOUNT_PAISE = 250_000; // ₹2,500

// THE CIRCUIT BREAKER. Total discount an entire run may approve, per arm.
//
// Every other rule here is per-decision, so nothing bounded a RUN. The batch
// holds ₹31,33,800 of addressable cart value; at the widest ceiling a run could
// approve ₹7,83,450 and the first anyone would know is the report afterwards.
//
// Set at ~9.6% of addressable value — high enough that ordinary discounting
// never reaches it, low enough to catch a signal misfire or a model turning
// uniformly generous. It is a BREAKER, not a budget: if it trips, something is
// wrong, and the run summary says so.
//
// IT REFUSES FURTHER SPEND RATHER THAN HALTING THE RUN, and that distinction is
// load-bearing. Halting would let one arm process fewer events than the other,
// which voids the paired comparison outright — the same class of confound the
// universal layer exists to prevent. Refusing spend keeps every event decided
// under identical rules in both arms, so a trip is a reported result rather than
// a truncated run.
export const RUN_DISCOUNT_BUDGET_PAISE = 30_000_000; // ₹3,00,000 per arm

// Total forced escalations a run may make, per arm. Same breaker logic: with the
// value floor in place the batch forces ~4% (about 69 of 1,720), so this sits
// far above normal and catches a systematic misfire routing an unbounded number
// of customers to human review — the "no escalation budget" gap recorded in
// CLAUDE.md's known limits.
export const MAX_FORCED_ESCALATIONS_PER_RUN = 250;

// ---------------------------------------------------------------------------
// CEILINGS
// ---------------------------------------------------------------------------
//
// The full ladder, so the interactions are visible in one place. Brakes take
// the MINIMUM across active signals, so a customer matching several lands on
// the tightest. DEFAULT is the fallback when nothing contributes, never a
// participant in the minimum — see resolveSignalEffects.
//
//   25%  provenPayer                     (accelerator, needs count AND value)
//   20%  DEFAULT                          (nothing fired)
//   20%  unresolved_merchant_fault        (contributes no cap: at the default)
//   15%  unresolved_neutral
//   15%  repeatRecoveryWithThisAgent / repeatRecoveryAcrossAgents
//   10%  unresolved_customer_fault
//   --   adverse                          (blocks entirely, no ceiling)
export const DEFAULT_DISCOUNT_CAP_PERCENT = 20;
export const PROVEN_PAYER_DISCOUNT_CAP_PERCENT = 25;

// Discount ceiling per caution level, as a percentage of the event amount.
//
// `adverse` is DELIBERATELY ABSENT: a dispute ruled against the customer no
// longer sets a ceiling, it blocks spending outright. It used to share the 10%
// ceiling with unresolved_customer_fault, which treated a bank's actual ruling
// as equivalent to an unproven allegation whose only evidence is which reason
// the customer picked from a dropdown. Those are not the same fact and must not
// carry the same weight. Excluding it from this map is what makes the
// distinction unforgettable rather than a comment someone can drift away from.
//
// A ceiling also only bites when the model wanted to spend MORE than it, so a
// ceiling on the strongest negative evidence in a payments business could
// silently do nothing at all. A block always bites.
//
// unresolved_merchant_fault sits at the DEFAULT rather than below it, and that
// is the point: a customer who says goods never arrived is making a claim about
// the merchant, so nothing about them warrants extra caution, and they are also
// not held back from the proven-payer ceiling. A goodwill BONUS above the
// default was considered and rejected: it would let anyone unlock a wider
// ceiling by filing a "goods not received" dispute, which is a fraud path
// rather than a product feature.
export const DISCOUNT_CAP_PERCENT_BY_CAUTION_LEVEL: Record<
  Exclude<DisputeCautionLevel, "adverse">,
  number
> = {
  none: DEFAULT_DISCOUNT_CAP_PERCENT,
  unresolved_merchant_fault: DEFAULT_DISCOUNT_CAP_PERCENT,
  unresolved_neutral: 15,
  unresolved_customer_fault: 10,
};
