// The shared objective and cost model, included VERBATIM in both the baseline
// and the memory-informed system prompts.
//
// THIS TEXT MUST BE BYTE-IDENTICAL IN BOTH ARMS. The baseline is the control in
// a paired comparison: the only intended difference between the two arms is
// whether the agent can see the customer's shared history. If the baseline
// receives a different objective — even a slightly weaker or shorter one — then
// any measured difference is partly the objective's doing and the comparison no
// longer isolates memory. That is why this lives in one exported constant used
// by both prompts rather than being written out twice; a copy would drift.
// scripts/verifyObjectiveShared.ts asserts both arms contain it.
//
// It is also deliberately ARM-NEUTRAL: it states the goal and the relative cost
// of each lever, and says nothing whatsoever about memory, disputes, gaming,
// churn, or customer history. Anything memory-specific belongs in the memory
// policy block, which only the memory arm receives.
//
// Costs are expressed as a RELATIVE ORDERING, not as rupee figures. The outcome model
// does carry concrete numbers (ESCALATION_HANDLING_COST_PAISE,
// DISPUTE_HANDLING_FEE_PAISE in src/outcomes/probabilities.ts), and they are
// deliberately NOT surfaced here: those numbers are how decisions get SCORED,
// and an agent optimising against the same table that grades it would be
// marking its own homework. The agent gets the shape of the trade-off; the
// scorer keeps the numbers.
export const OBJECTIVE_BLOCK = `
Your goal is to recover revenue that would otherwise be lost, at the lowest cost
that achieves it.

The actions available to you do not cost the same:
- A discount permanently gives up margin on this sale. It is the most expensive
  lever you have.
- A reminder or a payment retry costs almost nothing.
- Escalating to a human costs that person's time. It is worth spending when an
  automated decision would be wrong or risky, and wasted when automation would
  have handled the case perfectly well.

A recovery that did not need a discount is a better outcome than one that did.
And not every case is worth recovering at any price.`;

// Appended AFTER the data in the user message, in BOTH arms, for the same
// reason OBJECTIVE_BLOCK is shared: it is arm-neutral task framing, and a
// difference in it would be a difference between the arms that has nothing to
// do with memory. Data first, instruction last — the model reads the case
// before being asked to rule on it, and the request does not trail off on a
// closing brace.
export const CLOSING_INSTRUCTION = `Decide now for this customer and this event, following the objective and the
constraints above. Reason first, then choose the cheapest action that is
sufficient.`;

// Helper so no caller hand-assembles the two halves differently.
export function withClosingInstruction(payload: string): string {
  return `${payload}\n\n${CLOSING_INSTRUCTION}`;
}
