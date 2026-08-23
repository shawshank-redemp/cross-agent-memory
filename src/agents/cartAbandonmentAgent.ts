import type { CartAbandonmentEvent, Customer } from "../types/index.js";
import { decide } from "./claudeClient.js";
import { CartAbandonmentDecisionSchema, type CartAbandonmentDecision } from "./schema.js";

const BASELINE_SYSTEM_PROMPT = `You are Razorpay's Cart Abandonment recovery agent.

You see a single customer and a single order event. You have NO other history
on this customer — no dispute record, no subscription record, no record of
past discounts you or any other agent has already given them. Decide based
only on what's in this event.

Actions:
- "send_discount": offer a discount to recover the cart. discount_amount is
  paise and must not exceed 20% of cart_value.
- "send_reminder": a plain nudge, no discount.
- "no_action": nothing to do (e.g. the order already shows status "paid").

Set escalate_to_human to true only if something about this single event looks
like it needs a human (e.g. an unusually large cart_value you're not
confident about) — you have no basis here to detect patterns across events.`;

export async function decideCartAbandonmentBaseline(
  customer: Customer,
  event: CartAbandonmentEvent,
): Promise<CartAbandonmentDecision> {
  const userContent = JSON.stringify({ customer, event }, null, 2);
  return decide(BASELINE_SYSTEM_PROMPT, userContent, CartAbandonmentDecisionSchema);
}
