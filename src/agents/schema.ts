import { z } from "zod";

// Shared decision shape across all three agents; only the `action` enum
// differs per agent. discount_amount is paise, null when the action doesn't
// involve a discount. escalate_to_human is the compliant-escalation signal
// CLAUDE.md's grading bar requires as a distinct, explicit field (not just
// inferable from `action`) so the runner can count escalations directly.
function decisionSchema<T extends readonly [string, ...string[]]>(actions: T) {
  return z.object({
    action: z.enum(actions),
    discount_amount: z
      .number()
      .int()
      .nullable()
      .describe("Discount granted, in paise. null if this decision does not grant a discount."),
    escalate_to_human: z.boolean(),
    reasoning: z
      .string()
      .describe("Plain-language rationale: what was read from memory (if any) and why this action follows."),
  });
}

export const CART_ABANDONMENT_ACTIONS = ["send_discount", "send_reminder", "no_action"] as const;
export const CartAbandonmentDecisionSchema = decisionSchema(CART_ABANDONMENT_ACTIONS);
export type CartAbandonmentDecision = z.infer<typeof CartAbandonmentDecisionSchema>;

export const SUBSCRIPTION_RECOVERY_ACTIONS = [
  "retry_payment",
  "send_discount",
  "escalate_to_human",
  "no_action",
] as const;
export const SubscriptionRecoveryDecisionSchema = decisionSchema(SUBSCRIPTION_RECOVERY_ACTIONS);
export type SubscriptionRecoveryDecision = z.infer<typeof SubscriptionRecoveryDecisionSchema>;

export const DISPUTE_RESPONDER_ACTIONS = ["accept_dispute", "contest_dispute", "escalate_to_human"] as const;
export const DisputeResponderDecisionSchema = decisionSchema(DISPUTE_RESPONDER_ACTIONS);
export type DisputeResponderDecision = z.infer<typeof DisputeResponderDecisionSchema>;

export type AgentDecision =
  | CartAbandonmentDecision
  | SubscriptionRecoveryDecision
  | DisputeResponderDecision;
