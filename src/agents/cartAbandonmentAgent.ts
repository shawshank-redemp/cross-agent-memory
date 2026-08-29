import type Database from "better-sqlite3";
import type { CartAbandonmentEvent, Customer } from "../types/index.js";
import { decide } from "./claudeClient.js";
import { decideWithMemory, type WithMemoryAudit } from "./memoryContext.js";
import { CartAbandonmentDecisionSchema, type CartAbandonmentDecision } from "./schema.js";
import { emitTrace } from "./trace.js";

const BASELINE_SYSTEM_PROMPT = `You are Razorpay's Cart Abandonment recovery agent.

You see a single customer and a single order event. You have NO other history
on this customer — no dispute record, no subscription record, no record of
past discounts you or any other agent has already given them. Decide based
only on what's in this event.

Actions:
- "send_discount": offer a discount to recover the cart. discount_amount is
  paise and must not exceed 20% of the order amount.
- "send_reminder": a plain nudge, no discount.
- "no_action": nothing to do (e.g. the order already shows status "paid").

Set escalate_to_human to true only if something about this single event looks
like it needs a human (e.g. an unusually large order amount you're not
confident about) — you have no basis here to detect patterns across events.`;

export async function decideCartAbandonmentBaseline(
  db: Database.Database,
  customer: Customer,
  event: CartAbandonmentEvent,
): Promise<CartAbandonmentDecision> {
  const userContent = JSON.stringify({ customer, event }, null, 2);
  const stepStart = Date.now();
  const decision = await decide(BASELINE_SYSTEM_PROMPT, userContent, CartAbandonmentDecisionSchema);
  emitTrace(
    {
      db,
      customerId: customer.customer_id,
      eventId: event.order_id,
      agent: "cart_abandonment",
      mode: "baseline",
      stepOrder: 1,
    },
    "agent_reasoning",
    decision.reasoning,
    Date.now() - stepStart,
  );
  return decision;
}

const MEMORY_SYSTEM_PROMPT = `You are Razorpay's Cart Abandonment recovery agent.

Actions:
- "send_discount": offer a discount to recover the cart. discount_amount is
  paise, normally capped at 20% of the order amount (see policy_signals below for
  when that cap tightens).
- "send_reminder": a plain nudge, no discount.
- "no_action": nothing to do (e.g. the order already shows status "paid").`;

export async function decideCartAbandonmentMemory(
  db: Database.Database,
  customer: Customer,
  event: CartAbandonmentEvent,
): Promise<WithMemoryAudit<CartAbandonmentDecision>> {
  return decideWithMemory({
    db,
    customer,
    agent: "cart_abandonment",
    event,
    eventId: event.order_id,
    eventTimestamp: event.created_at,
    // attempts = 0 means the customer never reached payment (an intent
    // problem, which a discount can address); >= 1 with an error code means
    // the payment was tried and declined (a mechanical problem, which a
    // discount does not address).
    eventFacts: {
      amount: event.amount,
      paymentAttempted: event.attempts >= 1,
      paymentErrorCode: event.last_error_code,
    },
    systemPrompt: MEMORY_SYSTEM_PROMPT,
    schema: CartAbandonmentDecisionSchema,
    fallbackNonDiscountAction: "send_reminder",
    memoryReadReason: `Cart abandonment agent evaluating order ${event.order_id} for discount eligibility`,
  });
}
