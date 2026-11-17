import type { z } from "zod";
import {
  CartAbandonmentDecisionSchema,
  DisputeResponderDecisionSchema,
  SubscriptionRecoveryDecisionSchema,
} from "../agents/schema.js";
import type { AgentType } from "../types/index.js";
import type { LLMProvider, LLMStructuredOutput } from "./provider.js";

const ACTION_BY_AGENT: Record<AgentType, string> = {
  cart_abandonment: "send_reminder",
  subscription_recovery: "retry_payment",
  dispute_responder: "contest_dispute",
};

function agentForSchema(schema: z.ZodType): AgentType {
  if (schema === CartAbandonmentDecisionSchema) return "cart_abandonment";
  if (schema === SubscriptionRecoveryDecisionSchema) return "subscription_recovery";
  if (schema === DisputeResponderDecisionSchema) return "dispute_responder";
  throw new Error("Mock provider received an unsupported decision schema without agent context");
}

export class MockProvider implements LLMProvider {
  readonly name = "mock";
  readonly model = "mock-decision-v1";

  async generateStructured<Schema extends z.ZodType>(
    system: string,
    userContent: string,
    schema: Schema,
    context?: Parameters<LLMProvider["generateStructured"]>[3],
  ): Promise<LLMStructuredOutput<z.infer<Schema>>> {
    const agent = context?.agent ?? agentForSchema(schema);
    const candidate = {
      reasoning: `Mock decision for ${agent}: use the conservative no-spend intervention.`,
      memory_factors_used: [],
      action: ACTION_BY_AGENT[agent],
      committed_spend_paise: null,
      escalate_to_human: false,
      escalation_reason: null,
    };
    const parsed = schema.parse(candidate);
    const rawText = JSON.stringify(candidate);
    const inputTokens = Math.max(50, Math.ceil((system.length + userContent.length) / 4));
    const outputTokens = Math.max(20, Math.ceil(rawText.length / 4));
    const usage = {
      inputTokens,
      outputTokens,
      cachedTokens: Math.floor(inputTokens * 0.12),
      cacheWriteTokens: 0,
      latencyMs: Math.max(350, Math.round((outputTokens / 40) * 1000)),
      model: this.model,
    };

    return { parsed, rawText, usage };
  }
}

export const mockProvider = new MockProvider();
