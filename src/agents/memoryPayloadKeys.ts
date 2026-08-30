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
//
// PROSE CARRIES JUDGMENTS, JSON CARRIES MAGNITUDES. That is why the two
// amount fields are here rather than below: a signal can say "a dispute was
// resolved against this customer", but no signal says whether it was for a
// trivial sum or a ruinous one, and those are different facts that should lead
// to different decisions.
export const MEMORY_PROFILE_ALWAYS_KEYS = [
  "dispute_count",
  "total_disputed_amount",
  // Was conditional, which had it exactly backwards. It is only ever sent when
  // the caution level is "none"; "none" requires customer_adverse === 0; and
  // this field sums the amounts of those same customer_adverse rows. So it was
  // guaranteed to be 0 every time it was sent, and withheld every time it was
  // not — the model was told a dispute had been resolved against the customer
  // and never told for how much. Measured on the committed batch: sent on 1785
  // cart events, non-zero in 0 of them; withheld while non-zero on 58.
  //
  // Always-sending it also makes the zero informative rather than noise: 0 here
  // means "nothing has been resolved against this customer", which is a fact
  // worth having stated.
  "adverse_disputed_amount",
  "successful_payment_count",
  "total_paid_amount",
  "rolling_health_score",
  "discount_usage_history",
  "recent_decisions",
] as const;

// Sent only when the dispute caution level is "none" — otherwise the generated
// prose already states the finding these would support, and repeating it costs
// tokens for nothing.
//
// Both of these are JUDGMENT-shaped: a breakdown of outcomes and a list of
// reasons are what the caution level is derived FROM, so once the level is
// stated they add nothing. Contrast adverse_disputed_amount, which was moved to
// the always-list above precisely because it is a magnitude no prose carries.
export const MEMORY_PROFILE_CONDITIONAL_KEYS = [
  "dispute_breakdown",
  "unresolved_dispute_reasons",
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
