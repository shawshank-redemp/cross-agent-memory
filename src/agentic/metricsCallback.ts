import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";
import { computeCost } from "../llm/pricing.js";
import type { LLMUsage } from "../llm/provider.js";

// Records every model call of the agentic arm into llm_call_metrics, with the
// same columns and the same cost function as the production instrumentation
// (src/llm/instrumentedProvider.ts). LangGraph reports one callback per call, so
// this replaces the provider wrapper for this arm.
//
// Each call gets a step type from what the model returned:
//   final      - it called submit_decision (the decision itself)
//   tool_call  - it called an investigation tool
//   reason     - it returned text without a tool call
export const STEP_TYPES = ["reason", "tool_call", "final"] as const;
export type StepType = (typeof STEP_TYPES)[number];

export interface AgenticMetricsContext {
  db: Database.Database;
  customerId: string;
  eventId: string;
  model: string;
  pricingModel?: string;
}

interface GenerationMessage {
  tool_calls?: Array<{ name: string }>;
  usage_metadata?: { input_tokens?: number; output_tokens?: number };
}

export function stepTypeFor(message: GenerationMessage | undefined): StepType {
  const names = (message?.tool_calls ?? []).map((call) => call.name);
  if (names.includes("submit_decision")) return "final";
  if (names.length > 0) return "tool_call";
  return "reason";
}

export class AgenticMetricsCallback extends BaseCallbackHandler {
  name = "agentic_metrics_recorder";
  private startedAt = new Map<string, number>();
  // Step type of the latest recorded call. Read by the caller to count tool calls.
  readonly stepTypes: StepType[] = [];

  constructor(private readonly ctx: AgenticMetricsContext) {
    super();
  }

  override handleChatModelStart(_llm: unknown, _messages: unknown, runId: string): void {
    this.startedAt.set(runId, Date.now());
  }

  override handleLLMEnd(output: LLMResult, runId: string): void {
    const latencyMs = Date.now() - (this.startedAt.get(runId) ?? Date.now());
    this.startedAt.delete(runId);
    const message = output.generations[0]?.[0] as { message?: GenerationMessage } | undefined;
    const meta = message?.message?.usage_metadata;
    const usage: LLMUsage = {
      inputTokens: meta?.input_tokens ?? 0,
      outputTokens: meta?.output_tokens ?? 0,
      cachedTokens: 0,
      latencyMs,
      model: this.ctx.model,
      pricingModel: this.ctx.pricingModel,
    };
    this.write(usage, latencyMs, stepTypeFor(message?.message), "success", null);
  }

  override handleLLMError(err: Error, runId: string): void {
    const latencyMs = Date.now() - (this.startedAt.get(runId) ?? Date.now());
    this.startedAt.delete(runId);
    this.write(undefined, latencyMs, "reason", "error", err.message);
  }

  private write(
    usage: LLMUsage | undefined,
    latencyMs: number,
    stepType: StepType,
    status: "success" | "error",
    error: string | null,
  ): void {
    this.stepTypes.push(stepType);
    const cost = usage ? computeCost(usage, usage.pricingModel ?? usage.model) : null;
    this.ctx.db
      .prepare(
        `INSERT INTO llm_call_metrics
         (trace_id, span_id, parent_span_id, customer_id, event_id, agent, mode, step_type,
          model, input_tokens, output_tokens, cached_tokens, cache_write_tokens, latency_ms,
          tokens_per_second, cost_usd, status, error, recorded_at)
         VALUES (?, ?, NULL, ?, ?, 'cart_abandonment', 'agentic', ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        randomUUID(),
        this.ctx.customerId,
        this.ctx.eventId,
        stepType,
        this.ctx.model,
        usage?.inputTokens ?? 0,
        usage?.outputTokens ?? 0,
        latencyMs,
        latencyMs > 0 ? ((usage?.outputTokens ?? 0) * 1000) / latencyMs : 0,
        cost,
        status,
        error,
        new Date().toISOString(),
      );
  }
}
