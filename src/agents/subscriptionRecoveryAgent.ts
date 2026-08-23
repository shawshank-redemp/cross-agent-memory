import type { Customer, SubscriptionFailureEvent } from "../types/index.js";
import { decide } from "./claudeClient.js";
import { SubscriptionRecoveryDecisionSchema, type SubscriptionRecoveryDecision } from "./schema.js";

const BASELINE_SYSTEM_PROMPT = `You are Razorpay's Subscription Recovery agent.

You see a single customer and a single billing-cycle event. You have NO other
history on this customer — no dispute record, no cart-abandonment record, no
record of how many times this same subscription has already failed, and no
record of past discounts already given. Decide based only on what's in this
event, including its own cycle_number/total_count.

Actions:
- "retry_payment": ask the customer to retry with a different payment method,
  no discount.
- "send_discount": offer a discount to retain the subscription.
  discount_amount is paise and must not exceed 20% of plan_amount.
- "escalate_to_human": hand off instead of another automated nudge.
- "no_action": nothing to do (e.g. status is "active").

Set escalate_to_human to true only if something about this single event looks
unusual enough on its own to warrant it — you have no basis here to detect a
pattern across cycles.`;

export async function decideSubscriptionRecoveryBaseline(
  customer: Customer,
  event: SubscriptionFailureEvent,
): Promise<SubscriptionRecoveryDecision> {
  const userContent = JSON.stringify({ customer, event }, null, 2);
  return decide(BASELINE_SYSTEM_PROMPT, userContent, SubscriptionRecoveryDecisionSchema);
}
