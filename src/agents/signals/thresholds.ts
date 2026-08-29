import { PROFILE_RECENT_EVENTS_LOOKBACK_DAYS } from "../../memory/profile.js";
import type { DisputeCautionLevel } from "./types.js";

// Bounded per-agent limit: once an agent has already granted this many
// discounts to the same customer (in this comparison run), it must stop
// negotiating and escalate instead — this is both the CLAUDE.md-required
// stopping rule and the payoff of gaming detection.
export const MAX_DISCOUNT_ATTEMPTS_PER_AGENT = 3;

// Cross-agent gaming: a customer who triggers cart abandonment twice,
// subscription recovery twice, and a dispute once (5 events total) is
// exploiting recovery flows just as much as one who triggers a single agent's
// flow 3+ times — but per-agent gamingSuspected would never catch it, since no
// individual agent count crosses its own threshold. Deliberately a different
// number from MAX_DISCOUNT_ATTEMPTS_PER_AGENT so the two signals are
// distinguishable (and testable) as separate causes.
export const MAX_TOTAL_RECOVERY_EVENTS_ACROSS_AGENTS = 5;

// Composite churn signal: how far back to look for activity in other domains.
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
// comment, because the two constants live in different files.
if (CHURN_LOOKBACK_DAYS > PROFILE_RECENT_EVENTS_LOOKBACK_DAYS) {
  throw new Error(
    `CHURN_LOOKBACK_DAYS (${CHURN_LOOKBACK_DAYS}) exceeds PROFILE_RECENT_EVENTS_LOOKBACK_DAYS ` +
      `(${PROFILE_RECENT_EVENTS_LOOKBACK_DAYS}): recent_events would be truncated below what this rule needs.`,
  );
}

// provenPayer: how many successful payments across all domains before a
// customer counts as established. Deliberately low — the signal is meant to
// separate "we have seen this person pay us" from "we have never seen this
// person pay us", not to identify a VIP tier.
export const MIN_SUCCESSFUL_PAYMENTS = 2;

// The standing ceiling when no signal says otherwise.
export const DEFAULT_DISCOUNT_CAP_PERCENT = 20;

// What a proven payer is allowed instead. Brakes still outrank this — see
// resolveSignalEffects.
export const PROVEN_PAYER_DISCOUNT_CAP_PERCENT = 25;

// Discount ceiling per caution level, as a percentage of the event amount.
//
// unresolved_merchant_fault sits at the DEFAULT rather than below it, and that
// is the point: a customer who says goods never arrived is making a claim
// about the merchant, so nothing about them warrants extra caution. Because a
// level at or above the default contributes no cap at all (see the
// disputeCautionLevel definition), such a customer is also not held back from
// the proven-payer ceiling. Treating a wronged customer as actively
// higher-VALUE than a clean one — a goodwill bonus rather than merely no
// penalty — is a different product decision with its own risks, and is a valid
// future extension rather than something to smuggle in here.
export const DISCOUNT_CAP_PERCENT_BY_CAUTION_LEVEL: Record<DisputeCautionLevel, number> = {
  none: DEFAULT_DISCOUNT_CAP_PERCENT,
  unresolved_merchant_fault: DEFAULT_DISCOUNT_CAP_PERCENT,
  unresolved_neutral: 15,
  unresolved_customer_fault: 10,
  adverse: 10,
};
