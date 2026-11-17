import type { AgentType } from "../types/index.js";
import { AGENT_ACTION_POLICY } from "./schema.js";
import { POLICY_FINGERPRINT } from "./policy.js";
import type { DecisionLike } from "./runner.js";

export function createLLMValidationHandoff(
  agent: AgentType,
  error: Error,
): DecisionLike {
  const action = AGENT_ACTION_POLICY[agent].nonSpendFallbackAction;
  const notes = `structured LLM response failed validation twice; routed to human review (${error.message})`;
  return {
    reasoning: `[HUMAN REVIEW] ${notes}.`,
    memory_factors_used: [],
    action,
    committed_spend_paise: null,
    escalate_to_human: true,
    escalation_reason: "policy_constraint",
    policy_version: POLICY_FINGERPRINT,
    policy_override: {
      original_action: "unvalidated_model_output",
      original_committed_spend_paise: null,
      original_escalate_to_human: false,
      triggered_by: ["llm_response_validation_failed"],
      notes,
      escalation_reason_forced: true,
    },
  };
}
