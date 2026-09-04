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
// IT STATES EFFECTIVENESS AS WELL AS COST, and that second half is not optional.
//
// This block used to price every lever and describe the efficacy of none, which
// left "the lowest cost that achieves it" with no way to decide what achieves
// anything: to judge a reminder insufficient the agent needs some basis for
// believing a reminder often fails, and it was given the opposite impression.
// With cost fully specified and efficacy entirely unspecified, minimising cost
// was the only defined objective and send_reminder was the argmin on every
// event. Measured on the batch of 2026-08-30: `send_discount` was proposed 0
// times in 3,440 decisions across BOTH arms, so both arms scored zero spend and
// the comparison this project exists to make measured nothing. Nothing
// downstream was at fault — the model was never asked to spend, so the caps, the
// block rules and the clamping all governed a lever that was never pulled.
//
// EFFICACY IS QUALITATIVE, for the same marking-its-own-homework reason the
// costs are. OUTCOME_PROBABILITIES holds exactly the numbers that would answer
// "how much better is a discount" (paysWithDiscount vs paysWithoutDiscount, per
// scenario), and putting them here would let the agent optimise against the
// table that grades it. An earlier draft said a reminder "leaves most of these
// cases unrecovered" — close enough to those rates to be a leak, and wrong for
// the loyal_payer cohort besides, where the majority convert unaided. The
// logical form ("it asks the customer to do what they already chose not to do")
// is stronger and cannot be accused of either.
//
// NO FIXED ORDERING OF THE THREE LEVERS. The block used to assert that a
// discount is "the most expensive lever you have", which is simply false at
// small amounts: a 2% discount on a typical cart costs less than a human
// review. The model reasons from that ordering, so stating it as fixed pushed
// it away from exactly the small, efficient discounts most likely to be worth
// making. A discount is instead described as the only lever whose cost the
// agent CHOOSES — which is accurate, and which is what makes the sizing
// instruction ("the smallest amount that will work") follow naturally rather
// than being bolted on.
//
// DELIBERATELY SILENT ON DECLINED PAYMENTS. An earlier draft said a discount is
// wasted when the payment was attempted and mechanically declined. It was cut
// on a product judgment: an attempted-and-failed payment is a payment-failure
// flow with its own retry logic, not a cart abandonment, so the case should not
// be reaching this agent at all. The batch currently contains 589 such events
// against 557 genuine checkout drop-offs — that is a GENERATOR scoping question
// to settle separately, not something to paper over with a clause here.
//
// TWO BELIEFS THE MODEL BRINGS ON ITS OWN, both measured on a real 10-call run
// (2026-09-04, cust_4lqAKoEY2Il2Vw, both arms) after the effectiveness half was
// already in place. That run still produced zero discounts in either arm, and
// the reasoning said exactly why.
//
// DEFERRAL. "the discount lever stays available if this cart stalls again";
// "a small discount within the ceiling can be revisited then". The model
// believes it is opening a sequence — cheap now, escalate later if it fails —
// which is sound reasoning about a system we do not have. Each event is decided
// exactly once and nothing further is ever sent. The closing paragraph now says
// so. It is a fact about the harness, not a nudge.
//
// THE EVIDENCE BAR. "a discount would be spending margin to solve a problem I
// have no evidence exists". The model wants proof that price was the obstacle
// before committing margin — a burden this domain can never discharge, because
// an abandoned checkout is precisely the absence of that evidence. Waiting for
// it means never using the lever, forever.
//
// The first fix drafted for this was to tell the model the evidence would never
// arrive. That was weak: it removes an excuse without supplying grounds, and a
// careful model would reasonably conclude it therefore never has grounds.
//
// What actually dissolves it is that THE MODEL IS COSTING THE LEVER WRONG. It
// treats a discount as money paid up front, spent whether or not it lands — of
// course it wants proof first. A discount is contingent: the offer expires
// unspent if the customer does not return, and resolveOutcomes computes it that
// way (discount_redeemed is 0 on every unpaid branch). So the risk is not margin
// spent on someone who was never going to buy — that case is free. It is margin
// given to someone who would have bought anyway, which is a question about the
// customer's history rather than about their price sensitivity, and one memory
// can actually speak to. It is also the exact question the experimentation layer
// exists to measure.
//
// Both statements are arm-neutral, carry no figures, and command nothing. They
// remove two reasons the model invented for never considering the lever, and
// hand it a better question than the unanswerable one it was asking.
//
// It is also SHORT on purpose. An earlier draft ran ~230 words across two
// sections, one for costs and one for effectiveness, which forced every lever to
// be named twice. One bullet per lever carrying both halves says the same
// fourteen things in half the words. Length was the only thing removed.
export const OBJECTIVE_BLOCK = `
Your goal is to recover revenue that would otherwise be lost, without spending
more than the recovery is worth.

- A reminder or retry costs little, but it is weak: it asks the customer to do
  what they already chose not to do.
- A discount is the only lever whose cost you choose, and the only one that
  changes the terms of the customer's decision rather than repeating the
  request. It costs nothing unless it is used: if the customer does not
  return, the offer expires unspent. What it risks is not margin spent on
  someone who was never going to buy — that case costs nothing. It is margin
  given to someone who would have bought without it.
- Escalating costs a person's time, and only a few cases can reach one. It
  buys judgment automation cannot supply, and is worth it only when an
  automated decision would be wrong.

This is the only decision that will be made for this event. If what you choose
does not recover the sale, nothing further will be sent.

Choose the least expensive action that will actually work, and where that is a
discount, the smallest amount that will work rather than the largest permitted.
A recovery that needed no discount beats one that did — but a sale never
recovered is worse than either.`;

// Appended AFTER the data in the user message, in BOTH arms, for the same
// reason OBJECTIVE_BLOCK is shared: it is arm-neutral task framing, and a
// difference in it would be a difference between the arms that has nothing to
// do with memory. Data first, instruction last — the model reads the case
// before being asked to rule on it, and the request does not trail off on a
// closing brace.
export const CLOSING_INSTRUCTION = `Decide now for this customer and this event, following the objective and the
constraints above. Reason first, then decide.`;

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
