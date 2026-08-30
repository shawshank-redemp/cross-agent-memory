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

// The Dispute Responder's own economics, and the reason they are NOT in
// OBJECTIVE_BLOCK: that block ships in all three agents' prompts and must stay
// universal. accept_dispute and contest_dispute do not exist for the cart or
// subscription agents, so pricing them there would be noise competing with the
// case data.
//
// It matters that this exists at all. OBJECTIVE_BLOCK prices discounts,
// reminders and escalation — none of which is what the dispute agent does. So
// the agent making the single most expensive decision in this system (conceding
// forfeits the disputed amount in full) was inferring its economics from
// nothing. Its prompt described what its actions MEAN and never what they COST.
//
// ONE constant, interpolated into BOTH dispute prompts, for exactly the reason
// OBJECTIVE_BLOCK is: the baseline and memory dispute prompts are separate
// strings, and hand-writing this into each recreates the drift risk that shared
// constant exists to prevent.
//
// ARM-NEUTRAL by construction: it describes the economics of two actions, which
// are equally true with or without memory. It says nothing about dispute
// history, patterns across disputes, gaming or churn — which is what makes it
// safe to place in the control arm. Costs are a relative ordering, never rupee
// figures; DISPUTE_HANDLING_FEE_PAISE stays in the scorer.
export const DISPUTE_COST_MODEL = `
WHAT YOUR TWO ACTIONS COST

Conceding gives up the disputed amount in full. It is the most expensive action
available to you, and it is not recoverable afterwards.

Contesting costs effort, and it can still fail. When it succeeds, the amount is
preserved.

That asymmetry should shape how you choose. Conceding is right when the evidence
would not stand up; contesting is right when it would. Because a concession
forfeits everything while a failed contest costs only the effort, a weak contest
is usually still worth more than a reflexive concession — but conceding a
dispute you would clearly lose avoids spending effort to lose anyway.`;
