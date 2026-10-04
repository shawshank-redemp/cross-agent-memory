// Which events the runner owes a DECISION on.
//
// The runner used to decide on every row in all three event tables, which
// meant paying for an API call to work out how to recover a cart that was
// already paid, a subscription cycle that never failed, or a dispute that had
// already been ruled on. None of those has a recovery question to answer.
//
// SCOPE, and it matters: this filters which events get their OWN decision. It
// removes nothing from the database. Ineligible rows are still read by the
// asOf profile queries in memory/profile.ts — a paid cart is exactly what makes
// someone a provenPayer, and a resolved dispute is exactly what sets a caution
// level. Filtering the decision queue does not narrow memory.
//
// NOT the same thing as recovery-flow membership. profile.ts's
// readRecoveryFrequency and readRecentEvents count ALL disputes regardless of
// status, because a dispute that has since been ruled on still happened and is
// still evidence about the customer. Here a ruled dispute is ineligible,
// because the responder has nothing left to file. The two definitions agree on
// carts and subscriptions and deliberately diverge on disputes; they are kept
// separate rather than shared so that changing one cannot silently redefine the
// other.

import type { CartAbandonmentStatus, DisputeStatus, SubscriptionFailureStatus } from "../types/events.js";

// SQL fragments, written to be dropped in after a WHERE or AND. Each names its
// table's own status column only, so it composes with any other predicate.
export const CART_ELIGIBLE_SQL = "status != 'paid'";
export const SUBSCRIPTION_ELIGIBLE_SQL = "status IN ('failed','halted')";
export const DISPUTE_ELIGIBLE_SQL = "status IN ('open','under_review')";

// A cart that was never paid still has an open recovery question, whether the
// customer never reached payment (`created`) or tried and was declined
// (`attempted`).
export function isCartEligible(status: CartAbandonmentStatus): boolean {
  return status !== "paid";
}

// `active` and `completed` never failed; `cancelled` is gone and will not be
// retried. Only a failed or halted cycle has anything to recover.
export function isSubscriptionEligible(status: SubscriptionFailureStatus): boolean {
  return status === "failed" || status === "halted";
}

// `won`, `lost` and `closed` are terminal — the ruling has landed and there is
// no response left to file.
export function isDisputeEligible(status: DisputeStatus): boolean {
  return status === "open" || status === "under_review";
}

// Every status each enum can take, in one place, so the test that proves the
// SQL and the predicates agree can enumerate them exhaustively rather than
// sampling. Typed against the source enums, so adding a status to types/events
// without deciding its eligibility is a compile error here.
export const ALL_CART_STATUSES: readonly CartAbandonmentStatus[] = ["created", "attempted", "paid"];
export const ALL_SUBSCRIPTION_STATUSES: readonly SubscriptionFailureStatus[] = [
  "active",
  "failed",
  "halted",
  "cancelled",
  "completed",
];
export const ALL_DISPUTE_STATUSES: readonly DisputeStatus[] = ["open", "under_review", "won", "lost", "closed"];
