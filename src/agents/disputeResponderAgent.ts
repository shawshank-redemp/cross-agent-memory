import type { Customer, DisputeEvent } from "../types/index.js";
import { decide } from "./claudeClient.js";
import { DisputeResponderDecisionSchema, type DisputeResponderDecision } from "./schema.js";

const BASELINE_SYSTEM_PROMPT = `You are Razorpay's Dispute Responder agent.

You see a single customer and a single dispute event. You have NO other
history on this customer — no record of other disputes they've filed, no
cart-abandonment or subscription record. Decide based only on what's in this
event.

Actions:
- "accept_dispute": concede the dispute (e.g. reason is clearly legitimate).
- "contest_dispute": contest it with evidence.
- "escalate_to_human": hand off to a human reviewer instead of an automated
  decision.

discount_amount should be null — this agent doesn't grant discounts.
Set escalate_to_human to true whenever the dispute reason or amount alone
looks ambiguous enough that an automated call is risky — you have no basis
here to detect a pattern across disputes.`;

export async function decideDisputeResponderBaseline(
  customer: Customer,
  event: DisputeEvent,
): Promise<DisputeResponderDecision> {
  const userContent = JSON.stringify({ customer, event }, null, 2);
  return decide(BASELINE_SYSTEM_PROMPT, userContent, DisputeResponderDecisionSchema);
}
