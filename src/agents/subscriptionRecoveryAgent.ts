import type Database from "better-sqlite3";
import type { Customer, SubscriptionFailureEvent } from "../types/index.js";
import { decide } from "./claudeClient.js";
import { OBJECTIVE_BLOCK, withClosingInstruction } from "./objective.js";
import { decideWithMemory, type WithMemoryAudit } from "./memoryContext.js";
import { SubscriptionRecoveryDecisionSchema, type SubscriptionRecoveryDecision } from "./schema.js";
import { emitTrace } from "./trace.js";

export const SUBSCRIPTION_BASELINE_SYSTEM_PROMPT = `You are Razorpay's Subscription Recovery agent.
${OBJECTIVE_BLOCK}

You see a single customer and a single billing-cycle event. You have NO other
history on this customer — no dispute record, no cart-abandonment record, no
record of how many times this same subscription has already failed, and no
record of past discounts already given. Decide based only on what's in this
event, including its own paid_count/total_count.

Actions — pick exactly one:
- "retry_payment": ask the customer to retry, ideally with a different payment
  method. committed_spend_paise is null.
- "send_discount": offer a discount to retain the subscription.
  committed_spend_paise is the discount in paise and must not exceed 20% of
  plan_amount.
- "no_action": nothing to do (e.g. status is "active"). committed_spend_paise
  is null.

Separately from the action, set escalate_to_human when a person should sign
off before the action is taken. It is a flag on any action, not an action of
its own — "retry_payment with a human checking first" is a valid decision.
Here you can only judge this single cycle, so escalate when the event itself
looks unusual enough to warrant it; you have no basis to detect a pattern
across cycles.`;

export async function decideSubscriptionRecoveryBaseline(
  db: Database.Database,
  customer: Customer,
  event: SubscriptionFailureEvent,
): Promise<SubscriptionRecoveryDecision> {
  const userContent = withClosingInstruction(JSON.stringify({ customer, event }, null, 2));
  const stepStart = Date.now();
  const decision = await decide(SUBSCRIPTION_BASELINE_SYSTEM_PROMPT, userContent, SubscriptionRecoveryDecisionSchema);
  emitTrace(
    {
      db,
      customerId: customer.customer_id,
      eventId: event.payment_id,
      agent: "subscription_recovery",
      mode: "baseline",
      stepOrder: 1,
    },
    "agent_reasoning",
    decision.reasoning,
    Date.now() - stepStart,
  );
  return decision;
}

export const SUBSCRIPTION_MEMORY_SYSTEM_PROMPT = `You are Razorpay's Subscription Recovery agent.
${OBJECTIVE_BLOCK}

Actions — pick exactly one:
- "retry_payment": ask the customer to retry, ideally with a different payment
  method. committed_spend_paise is null.
- "send_discount": offer a discount to retain the subscription.
  committed_spend_paise is the discount in paise, normally capped at 20% of
  plan_amount (see policy_signals below for when that ceiling moves).
- "no_action": nothing to do (e.g. status is "active"). committed_spend_paise
  is null.

Separately from the action, set escalate_to_human when a person should sign
off before the action is taken. It is a flag on any action, not an action of
its own.`;

export async function decideSubscriptionRecoveryMemory(
  db: Database.Database,
  customer: Customer,
  event: SubscriptionFailureEvent,
): Promise<WithMemoryAudit<SubscriptionRecoveryDecision>> {
  return decideWithMemory({
    db,
    customer,
    agent: "subscription_recovery",
    event,
    eventId: event.payment_id,
    eventTimestamp: event.created_at,
    // A failed subscription charge IS a payment attempt by definition — the
    // gateway tried to bill a stored instrument and was declined.
    eventFacts: {
      amount: event.plan_amount,
      paymentAttempted: true,
      paymentErrorCode: event.error_code,
    },
    systemPrompt: SUBSCRIPTION_MEMORY_SYSTEM_PROMPT,
    schema: SubscriptionRecoveryDecisionSchema,
    // Where a blocked discount lands. "retry_payment" is the cheapest lever
    // that still does something, which is what policy wants when it has just
    // refused to let margin be spent.
    fallbackNonDiscountAction: "retry_payment",
    memoryReadReason: `Subscription recovery agent evaluating cycle ${event.paid_count}/${event.total_count} of ${event.subscription_id}`,
  });
}
