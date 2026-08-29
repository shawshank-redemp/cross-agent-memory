// THE CITABLE SET MUST EQUAL THE SET OF FIELDS THAT CAN APPEAR IN THE PAYLOAD.
//
// memory_factors_used asks the model which facts it used. If a field is sent
// but not citable, attribution silently under-reports — the model used it and
// had no way to say so. If a field is citable but never sent, it is a phantom
// option that can only ever be selected in error, inflating the counts. Both
// corrupt the attribution, in opposite directions.
//
// So the enum is DERIVED from these keys rather than hand-maintained
// alongside them, the same way MemorySignals is derived from the signal
// registry. buildUserContent's memory_profile object is typed against them, so
// emitting a key that is not listed here, or omitting one declared always
// present, fails to compile.
//
// "CAN appear" is the test, not "always appears": the conditional keys below
// are sent only when no dispute finding is stated in the generated prose, and
// they stay citable because the model simply will not cite what it was not
// given.

// Sent on every memory-arm call.
export const MEMORY_PROFILE_ALWAYS_KEYS = [
  "dispute_count",
  "total_disputed_amount",
  "successful_payment_count",
  "total_paid_amount",
  "rolling_health_score",
  "discount_usage_history",
  "recent_decisions",
] as const;

// Sent only when the dispute caution level is "none" — otherwise the generated
// prose already says what these would say, and repeating it costs tokens for
// nothing.
export const MEMORY_PROFILE_CONDITIONAL_KEYS = [
  "dispute_breakdown",
  "unresolved_dispute_reasons",
  "adverse_disputed_amount",
] as const;

export const MEMORY_PROFILE_EMITTABLE_KEYS = [
  ...MEMORY_PROFILE_ALWAYS_KEYS,
  ...MEMORY_PROFILE_CONDITIONAL_KEYS,
] as const;

export type MemoryProfileAlwaysKey = (typeof MEMORY_PROFILE_ALWAYS_KEYS)[number];
export type MemoryProfileEmittableKey = (typeof MEMORY_PROFILE_EMITTABLE_KEYS)[number];

// The shape buildUserContent must produce: every always-key required, the
// conditional keys optional, and nothing else permitted. This is what ties the
// enum to the payload rather than leaving them as two parallel lists.
export type MemoryProfilePayload = Record<MemoryProfileAlwaysKey, unknown> &
  Partial<Record<MemoryProfileEmittableKey, unknown>>;
