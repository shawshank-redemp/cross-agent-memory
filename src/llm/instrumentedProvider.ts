import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { computeCost } from "./pricing.js";
import type {
  LLMCallAttempt,
  LLMCallContext,
  LLMProvider,
  LLMStructuredBatchRequest,
  LLMStructuredOutput,
  LLMUsage,
} from "./provider.js";

export interface LLMUsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
}

const usageTotals: LLMUsageTotals = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
};

export function getLLMUsageTotals(): LLMUsageTotals {
  return { ...usageTotals };
}

function recordCall(
  context: LLMCallContext | undefined,
  usage: LLMUsage | undefined,
  elapsedMs: number,
  error?: unknown,
): void {
  if (!context) return;
  usageTotals.calls += 1;
  if (usage) {
    const costUsd = computeCost(usage, usage.pricingModel ?? usage.model);
    usageTotals.inputTokens += usage.inputTokens;
    usageTotals.outputTokens += usage.outputTokens;
    usageTotals.cachedTokens += usage.cachedTokens ?? 0;
    usageTotals.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
    usageTotals.costUsd =
      usageTotals.costUsd === null || costUsd === null
        ? null
        : usageTotals.costUsd + costUsd;
  }
  const latencyMs = usage?.latencyMs ?? elapsedMs;
  const model = usage?.model ?? "unknown";
  context.db
    .prepare(
      `INSERT INTO llm_call_metrics
       (trace_id, span_id, parent_span_id, customer_id, event_id, agent, mode, step_type,
        model, input_tokens, output_tokens, cached_tokens, cache_write_tokens, latency_ms, tokens_per_second,
        cost_usd, status, error, recorded_at)
       VALUES (@trace_id, @span_id, @parent_span_id, @customer_id, @event_id, @agent, @mode, @step_type,
        @model, @input_tokens, @output_tokens, @cached_tokens, @cache_write_tokens, @latency_ms, @tokens_per_second,
        @cost_usd, @status, @error, @recorded_at)`,
    )
    .run({
      trace_id: context.traceId ?? randomUUID(),
      span_id: randomUUID(),
      parent_span_id: context.parentSpanId ?? null,
      customer_id: context.customerId,
      event_id: context.eventId,
      agent: context.agent,
      mode: context.mode,
      step_type: context.stepType,
      model,
      input_tokens: usage?.inputTokens ?? 0,
      output_tokens: usage?.outputTokens ?? 0,
      cached_tokens: usage?.cachedTokens ?? 0,
      cache_write_tokens: usage?.cacheWriteTokens ?? 0,
      latency_ms: latencyMs,
      tokens_per_second: latencyMs > 0 ? ((usage?.outputTokens ?? 0) * 1000) / latencyMs : 0,
      cost_usd: usage ? computeCost(usage, usage.pricingModel ?? model) : null,
      status: error === undefined ? "success" : "error",
      error: error === undefined ? null : error instanceof Error ? error.message : String(error),
      recorded_at: new Date().toISOString(),
    });
}

export function instrumentProvider(provider: LLMProvider): LLMProvider {
  return {
    name: provider.name,
    model: provider.model,
    async generateStructured<Schema extends z.ZodType>(
      system: string,
      userContent: string,
      schema: Schema,
      context?: LLMCallContext,
    ): Promise<LLMStructuredOutput<z.infer<Schema>>> {
      const startedAt = Date.now();
      let attemptRecorded = false;
      const callContext = context
        ? {
            ...context,
            onAttempt: (attempt: LLMCallAttempt) => {
              attemptRecorded = true;
              recordCall(context, attempt.usage, attempt.latencyMs, attempt.error);
            },
          }
        : undefined;
      try {
        const result = await provider.generateStructured(system, userContent, schema, callContext);
        if (!attemptRecorded) recordCall(context, result.usage, Date.now() - startedAt);
        return result;
      } catch (err) {
        if (!attemptRecorded) recordCall(context, undefined, Date.now() - startedAt, err);
        throw err;
      }
    },
    ...(provider.generateStructuredBatch
      ? {
          async generateStructuredBatch<Schema extends z.ZodType>(
            requests: LLMStructuredBatchRequest[],
            schema: Schema,
            onProgress?: (done: number, total: number) => void,
          ): Promise<Map<string, LLMStructuredOutput<z.infer<Schema>>>> {
            const startedAt = Date.now();
            try {
              const results = await provider.generateStructuredBatch!(requests, schema, onProgress);
              const elapsedMs = Date.now() - startedAt;
              for (const request of requests) {
                const result = results.get(request.customId);
                if (result) recordCall(request.context, result.usage, elapsedMs);
                else recordCall(request.context, undefined, elapsedMs, "Batch did not return a result");
              }
              return results;
            } catch (err) {
              const elapsedMs = Date.now() - startedAt;
              for (const request of requests) {
                recordCall(request.context, undefined, elapsedMs, err);
              }
              throw err;
            }
          },
        }
      : {}),
  };
}
