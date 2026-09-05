import type Database from "better-sqlite3";
import type { Customer, SubscriptionFailureEvent } from "../types/index.js";
import { decide } from "./claudeClient.js";
import { baselineUserContent, takePrefetchedBaseline } from "./baselinePrefetch.js";
import type { z } from "zod";
import { applyBaselinePolicyWithTrace } from "./enforcement.js";
import type { PolicyOverrideRecord } from "../memory/profile.js";
import { OBJECTIVE_BLOCK, withClosingInstruction } from "./objective.js";
import { decideWithMemory, type WithMemoryAudit } from "./memoryContext.js";
import type { TriggeringEventFacts } from "./policy.js";
import { SubscriptionRecoveryDecisionSchema, type SubscriptionRecoveryDecision } from "./schema.js";

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

// A failed subscription charge IS a payment attempt by definition — the
// gateway tried to bill a stored instrument and was declined.
//
// ONE mapping, used by BOTH arms: the baseline needs the event amount to apply
// the universal spend ceiling, and inventing a second mapping for it is how the
// two arms would quietly start describing the same event differently.
function eventFacts(event: SubscriptionFailureEvent): Omit<TriggeringEventFacts, "agent" | "timestamp"> {
  return {
    amount: event.plan_amount,
    paymentAttempted: true,
    paymentErrorCode: event.error_code,
  };
}

export async function decideSubscriptionRecoveryBaseline(
  db: Database.Database,
  customer: Customer,
  event: SubscriptionFailureEvent,
): Promise<SubscriptionRecoveryDecision & { policy_override: PolicyOverrideRecord | null }> {
  const stepStart = Date.now();
  // A batched run resolved this before the loop started; anything the batch did
  // not return falls through to a live call. See baselinePrefetch.ts.
  const raw =
    takePrefetchedBaseline<z.infer<typeof SubscriptionRecoveryDecisionSchema>>(event.payment_id) ??
    (await decide(SUBSCRIPTION_BASELINE_SYSTEM_PROMPT, baselineUserContent(customer, event), SubscriptionRecoveryDecisionSchema));
  // The UNIVERSAL policy layer runs on the baseline arm too. Without it the
  // control would be the only path where model output reaches the ledger
  // unchecked, which is both a safety gap and a confound — see
  // enforcement.ts.
  const decision = applyBaselinePolicyWithTrace(raw, {
    agent: "subscription_recovery",
    eventAmount: eventFacts(event).amount,
    db,
    customerId: customer.customer_id,
    eventId: event.payment_id,
    modelDurationMs: Date.now() - stepStart,
  });
  return decision;
}

export const SUBSCRIPTION_MEMORY_SYSTEM_PROMPT = `You are Razorpay's Subscription Recovery agent.
${OBJECTIVE_BLOCK}

Actions — pick exactly one:
- "retry_payment": ask the customer to retry, ideally with a different payment
  method. committed_spend_paise is null.
- "send_discount": offer a discount to retain the subscription.
  committed_spend_paise is the discount in paise, normally capped at 20% of
  plan_amount (the signals block states when that ceiling moves).
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
    eventFacts: eventFacts(event),
    systemPrompt: SUBSCRIPTION_MEMORY_SYSTEM_PROMPT,
    schema: SubscriptionRecoveryDecisionSchema,
    memoryReadReason: `Subscription recovery agent evaluating cycle ${event.paid_count}/${event.total_count} of ${event.subscription_id}`,
  });
}
