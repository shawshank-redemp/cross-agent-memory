import type Database from "better-sqlite3";
import type { Customer, DisputeEvent } from "../types/index.js";
import { decide } from "./claudeClient.js";
import { OBJECTIVE_BLOCK, withClosingInstruction } from "./objective.js";
import { decideWithMemory, type WithMemoryAudit } from "./memoryContext.js";
import { DisputeResponderDecisionSchema, type DisputeResponderDecision } from "./schema.js";
import { emitTrace } from "./trace.js";

export const DISPUTE_BASELINE_SYSTEM_PROMPT = `You are Razorpay's Dispute Responder agent.
${OBJECTIVE_BLOCK}

You see a single customer and a single dispute event. You have NO other
history on this customer — no record of other disputes they've filed, no
cart-abandonment or subscription record. Decide based only on what's in this
event.

Actions — pick exactly one:
- "accept_dispute": concede the dispute (e.g. the reason is clearly
  legitimate). committed_spend_paise is null.
- "contest_dispute": contest it with evidence. committed_spend_paise is null.

This agent commits no margin, so committed_spend_paise is always null here.

Separately from the action, set escalate_to_human when a person should sign
off before the response goes out. It is a flag on either action, not an action
of its own — "contest_dispute, pending human review" is a valid decision, and
it is more useful to a reviewer than a bare escalation with no recommendation
attached. Here you can only judge this one dispute, so escalate when the
reason or amount alone is ambiguous enough that an automated call is risky;
you have no basis to detect a pattern across disputes.`;

export async function decideDisputeResponderBaseline(
  db: Database.Database,
  customer: Customer,
  event: DisputeEvent,
): Promise<DisputeResponderDecision> {
  const userContent = withClosingInstruction(JSON.stringify({ customer, event }, null, 2));
  const stepStart = Date.now();
  const decision = await decide(DISPUTE_BASELINE_SYSTEM_PROMPT, userContent, DisputeResponderDecisionSchema);
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

export const DISPUTE_MEMORY_SYSTEM_PROMPT = `You are Razorpay's Dispute Responder agent.
${OBJECTIVE_BLOCK}

Actions — pick exactly one:
- "accept_dispute": concede the dispute (e.g. the reason is clearly
  legitimate). committed_spend_paise is null.
- "contest_dispute": contest it with evidence. committed_spend_paise is null.

This agent commits no margin, so committed_spend_paise is always null here.

Separately from the action, set escalate_to_human when a person should sign
off before the response goes out. It is a flag on either action, not an action
of its own — always pair it with the response you would recommend, so the
reviewer inherits a recommendation rather than a bare handoff.

Here, gaming_suspected in policy_signals means this customer has filed 3+
disputes. A repeat-dispute pattern is itself a fraud signal that an isolated
event cannot reveal.`;

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
    systemPrompt: DISPUTE_MEMORY_SYSTEM_PROMPT,
    schema: DisputeResponderDecisionSchema,
    // Exists to typecheck. This agent's committed_spend_paise is always
    // null, so mustBlockDiscount can never fire here and this value can
    // never actually be applied — "contest_dispute" is the safe choice if
    // that ever changes, since conceding is the costly direction.
    fallbackNonDiscountAction: "contest_dispute",
    memoryReadReason: `Dispute responder agent evaluating dispute ${event.dispute_id} for payment ${event.payment_id}`,
  });
}
