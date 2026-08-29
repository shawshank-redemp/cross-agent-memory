import { z } from "zod";
import { MEMORY_PROFILE_EMITTABLE_KEYS } from "./memoryPayloadKeys.js";
import type { SignalId } from "./signals/registry.js";

// Memory facts a decision may cite in memory_factors_used. A FIXED enum, not
// free text, so the model cannot invent a factor name that no query could
// resolve — and DERIVED, not hand-written, so it cannot drift from what the
// request actually contains.
//
// First group: the memory_profile keys buildUserContent can emit. See
// memoryPayloadKeys.ts for why the citable set must equal the emittable set.
const MEMORY_PROFILE_FACTORS = MEMORY_PROFILE_EMITTABLE_KEYS;

// Second group: the signal ids from the registry. Every signal can appear in
// the payload — an ACTIVE one is stated in the generated prose, an INACTIVE one
// is sent in the policy_signals JSON by signalsNotInProse — so all of them are
// citable. Spelled out literally because z.enum needs a literal tuple, then
// checked against the registry below so the two cannot drift.
const SIGNAL_FACTORS = [
  "disputeCautionWarranted",
  "disputeCautionLevel",
  "discountAttemptsForAgent",
  "stoppingRuleHit",
  "gamingSuspected",
  "crossAgentGamingSuspected",
  "compositeChurnSignal",
  "provenPayer",
  "paymentFriction",
] as const;

// Compile-time guard: every registered signal must be citable. Registering a
// signal without adding it here stops the build rather than silently making it
// un-attributable.
type AssertSignalFactorsCoverRegistry = SignalId extends (typeof SIGNAL_FACTORS)[number] ? true : never;
const _assertSignalFactorsCoverRegistry: AssertSignalFactorsCoverRegistry = true;
void _assertSignalFactorsCoverRegistry;

export const MEMORY_FACTORS = [...MEMORY_PROFILE_FACTORS, ...SIGNAL_FACTORS] as const;
export type MemoryFactor = (typeof MEMORY_FACTORS)[number];

export const ESCALATION_REASONS = [
  "ambiguous_case",
  "policy_constraint",
  "high_value",
  "pattern_detected",
] as const;
export type EscalationReason = (typeof ESCALATION_REASONS)[number];

// Shared decision shape across all three agents; only the `action` enum
// differs per agent.
//
// DECLARATION ORDER IS LOAD-BEARING. Structured output generates fields in
// schema declaration order — verified against a real response, not assumed
// (see scripts/verifyFieldOrder.ts). `reasoning` last would mean the model
// commits to an action and then explains it, a post-hoc justification.
// Declared FIRST, those tokens are the reasoning the decision follows from.
// memory_factors_used sits second for the same reason: naming the evidence
// before choosing is part of deciding, not a label applied afterwards.
//
// No .max() on reasoning: under constrained decoding a hard cap either
// truncates mid-string (mangled audit rows) or fails validation and triggers
// the retry path, costing more than the tokens saved. max_tokens (2048) plus
// the stop_reason === "max_tokens" throw in claudeClient.ts are the runaway
// guardrail.
//
// escalate_to_human is a DISPOSITION, not an action: it says whether a person
// signs off before the action happens. It used to also be a value inside two
// of the action enums, which let a decision hold contradictory values (action
// "send_discount" with escalate_to_human true) and meant an escalated dispute
// reached a human as a bare "escalated" with no recommendation attached.
function decisionSchema<T extends readonly [string, ...string[]]>(actions: T) {
  return z.object({
    reasoning: z
      .string()
      .min(20, "reasoning must be a real explanation, not a placeholder")
      .describe(
        "Think here FIRST, before choosing an action: weigh what this case is, what the objective and constraints imply, and what the cheapest sufficient response is. 3-5 sentences. The action below should follow from this reasoning, not be explained by it after the fact.",
      ),
    memory_factors_used: z
      .array(z.enum(MEMORY_FACTORS))
      .describe(
        "Which specific facts about this customer your reasoning actually relied on. Empty array is correct and expected when nothing about their history mattered, or when you were given no history. Do not list a factor you did not use.",
      ),
    action: z.enum(actions),
    committed_spend_paise: z
      .number()
      .int()
      .nullable()
      .describe(
        "Margin this decision commits, in paise. null when the action spends nothing — which is itself information, not an inapplicable field.",
      ),
    escalate_to_human: z
      .boolean()
      .describe("Whether a person should sign off before this action is taken. Independent of which action you chose."),
    escalation_reason: z
      .enum(ESCALATION_REASONS)
      .nullable()
      .describe(
        "Why a person is needed. Must be set when escalate_to_human is true, and null when it is false.",
      ),
  });
}

export const CART_ABANDONMENT_ACTIONS = ["send_discount", "send_reminder", "no_action"] as const;
export const CartAbandonmentDecisionSchema = decisionSchema(CART_ABANDONMENT_ACTIONS);
export type CartAbandonmentDecision = z.infer<typeof CartAbandonmentDecisionSchema>;

// "escalate_to_human" is deliberately absent from these two enums — it is the
// boolean above, settable alongside any action.
export const SUBSCRIPTION_RECOVERY_ACTIONS = ["retry_payment", "send_discount", "no_action"] as const;
export const SubscriptionRecoveryDecisionSchema = decisionSchema(SUBSCRIPTION_RECOVERY_ACTIONS);
export type SubscriptionRecoveryDecision = z.infer<typeof SubscriptionRecoveryDecisionSchema>;

export const DISPUTE_RESPONDER_ACTIONS = ["accept_dispute", "contest_dispute"] as const;
export const DisputeResponderDecisionSchema = decisionSchema(DISPUTE_RESPONDER_ACTIONS);
export type DisputeResponderDecision = z.infer<typeof DisputeResponderDecisionSchema>;

export type AgentDecision =
  | CartAbandonmentDecision
  | SubscriptionRecoveryDecision
  | DisputeResponderDecision;
