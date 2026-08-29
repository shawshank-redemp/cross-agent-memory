import type Database from "better-sqlite3";
import type { Customer, DisputeEvent } from "../types/index.js";
import { decide } from "./claudeClient.js";
import { decideWithMemory, type WithMemoryAudit } from "./memoryContext.js";
import { DisputeResponderDecisionSchema, type DisputeResponderDecision } from "./schema.js";
import { emitTrace } from "./trace.js";

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
  db: Database.Database,
  customer: Customer,
  event: DisputeEvent,
): Promise<DisputeResponderDecision> {
  const userContent = JSON.stringify({ customer, event }, null, 2);
  const stepStart = Date.now();
  const decision = await decide(BASELINE_SYSTEM_PROMPT, userContent, DisputeResponderDecisionSchema);
  emitTrace(
    {
      db,
      customerId: customer.customer_id,
      eventId: event.dispute_id,
      agent: "dispute_responder",
      mode: "baseline",
      stepOrder: 1,
    },
    "agent_reasoning",
    decision.reasoning,
    Date.now() - stepStart,
  );
  return decision;
}

const MEMORY_SYSTEM_PROMPT = `You are Razorpay's Dispute Responder agent.

Actions:
- "accept_dispute": concede the dispute (e.g. reason is clearly legitimate).
- "contest_dispute": contest it with evidence.
- "escalate_to_human": hand off to a human reviewer instead of an automated
  decision.

discount_amount should be null — this agent doesn't grant discounts.

Here, gaming_suspected in policy_signals means this customer has filed 3+
disputes — a repeat-dispute pattern is itself a fraud signal an isolated
event can't reveal. If true, do not casually accept; lean toward contesting
or escalating, and name the repeat pattern explicitly in your reasoning.`;

export async function decideDisputeResponderMemory(
  db: Database.Database,
  customer: Customer,
  event: DisputeEvent,
): Promise<WithMemoryAudit<DisputeResponderDecision>> {
  return decideWithMemory({
    db,
    customer,
    agent: "dispute_responder",
    event,
    eventId: event.dispute_id,
    eventTimestamp: event.dispute_created_at,
    // A dispute is not a payment attempt: the underlying payment already
    // succeeded, in the past, outside this decision.
    eventFacts: {
      amount: event.amount,
      paymentAttempted: false,
      paymentErrorCode: null,
    },
    systemPrompt: MEMORY_SYSTEM_PROMPT,
    schema: DisputeResponderDecisionSchema,
    fallbackNonDiscountAction: "escalate_to_human",
    memoryReadReason: `Dispute responder agent evaluating dispute ${event.dispute_id} for payment ${event.payment_id}`,
  });
}
