import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { LLMResult } from "@langchain/core/outputs";
import { computeCost } from "../src/llm/pricing.js";
import type { LLMUsage } from "../src/llm/provider.js";

// Records every model call the PoC agent makes into llm_call_metrics, using the
// same columns and the same cost function as the production instrumentation
// (src/llm/instrumentedProvider.ts). Only the hook is different: LangGraph
// reports a callback per call, rather than a wrapped provider method.
//
// A call that fails before usage comes back is still recorded, labelled with
// the configured model name, never "unknown".
export interface MetricsContext {
  db: Database.Database;
  customerId: string;
  eventId: string;
  agent: string;
  model: string;
  pricingModel?: string;
}

interface Pending {
  startedAt: number;
}

export class MetricsCallback extends BaseCallbackHandler {
  name = "metrics_recorder";
  private pending = new Map<string, Pending>();

  constructor(private readonly ctx: MetricsContext) {
    super();
  }

  override handleChatModelStart(_llm: unknown, _messages: unknown, runId: string): void {
    this.pending.set(runId, { startedAt: Date.now() });
  }

  override handleLLMEnd(output: LLMResult, runId: string): void {
    const started = this.pending.get(runId)?.startedAt ?? Date.now();
    this.pending.delete(runId);
    const latencyMs = Date.now() - started;
    const message = output.generations[0]?.[0] as
      | { message?: { usage_metadata?: { input_tokens?: number; output_tokens?: number } } }
      | undefined;
    const meta = message?.message?.usage_metadata;
    const usage: LLMUsage = {
      inputTokens: meta?.input_tokens ?? 0,
      outputTokens: meta?.output_tokens ?? 0,
      cachedTokens: 0,
      latencyMs,
      model: this.ctx.model,
      pricingModel: this.ctx.pricingModel,
    };
    this.write(usage, latencyMs, "success", null);
  }

  override handleLLMError(err: Error, runId: string): void {
    const started = this.pending.get(runId)?.startedAt ?? Date.now();
    this.pending.delete(runId);
    const latencyMs = Date.now() - started;
    this.write(undefined, latencyMs, "error", err.message);
  }

  private write(usage: LLMUsage | undefined, latencyMs: number, status: "success" | "error", error: string | null): void {
    const cost = usage ? computeCost(usage, usage.pricingModel ?? usage.model) : null;
    this.ctx.db
      .prepare(
        `INSERT INTO llm_call_metrics
         (trace_id, span_id, parent_span_id, customer_id, event_id, agent, mode, step_type,
          model, input_tokens, output_tokens, cached_tokens, cache_write_tokens, latency_ms,
          tokens_per_second, cost_usd, status, error, recorded_at)
         VALUES (?, ?, NULL, ?, ?, ?, 'baseline', 'poc_tool_loop', ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        randomUUID(),
        this.ctx.customerId,
        this.ctx.eventId,
        this.ctx.agent,
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
