import type Database from "better-sqlite3";
import type { z } from "zod";
import type { AgentType } from "../types/index.js";
import { anthropicProvider } from "./anthropicProvider.js";
import { geminiProvider } from "./geminiProvider.js";
import { createOllamaProvider } from "./ollamaProvider.js";
import { LLMNonRetryableError } from "./errors.js";
import { getLLMUsageTotals, instrumentProvider } from "./instrumentedProvider.js";
import { mockProvider } from "./mockProvider.js";

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  batchDiscount?: number;
  latencyMs: number;
  model: string;
  // Paid-tier model whose rates price this call for NOTIONAL cost. Lets a
  // free local model (Ollama) be priced against a named row in pricing.ts
  // while the metrics row still records the model that actually ran.
  pricingModel?: string;
}

export interface LLMCallAttempt {
  usage?: LLMUsage;
  latencyMs: number;
  error?: unknown;
}

export interface LLMStructuredOutput<T> {
  parsed: T;
  usage: LLMUsage;
  rawText?: string | null;
}

export interface LLMCallContext {
  db: Database.Database;
  customerId: string;
  eventId: string;
  agent: AgentType;
  mode: "baseline" | "memory" | "agentic";
  stepType: string;
  traceId?: string;
  parentSpanId?: string | null;
  onAttempt?: (attempt: LLMCallAttempt) => void;
}

export interface LLMStructuredBatchRequest {
  customId: string;
  system: string;
  userContent: string;
  context?: LLMCallContext;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  generateStructured<Schema extends z.ZodType>(
    system: string,
    userContent: string,
    schema: Schema,
    context?: LLMCallContext,
  ): Promise<LLMStructuredOutput<z.infer<Schema>>>;
  generateStructuredBatch?<Schema extends z.ZodType>(
    requests: LLMStructuredBatchRequest[],
    schema: Schema,
    onProgress?: (done: number, total: number) => void,
  ): Promise<Map<string, LLMStructuredOutput<z.infer<Schema>>>>;
}

let instrumentedProvider: LLMProvider | null = null;
let instrumentedProviderKey = "";

export function getLLMProvider(): LLMProvider {
  const providerName = process.env.LLM_PROVIDER ?? "anthropic";
  const provider = providerName === "anthropic"
    ? anthropicProvider
    : providerName === "gemini"
      ? geminiProvider
    : providerName === "ollama"
      ? createOllamaProvider()
    : providerName === "mock"
      ? mockProvider
      : null;
  if (!provider) {
    throw new Error(
      `Unsupported LLM_PROVIDER "${providerName}". Supported providers: anthropic, gemini, ollama, mock`,
    );
  }
  const key = `${provider.name}:${provider.model}`;
  if (!instrumentedProvider || instrumentedProviderKey !== key) {
    instrumentedProvider = instrumentProvider(provider);
    instrumentedProviderKey = key;
  }
  return instrumentedProvider;
}

export { getLLMUsageTotals };

export interface RawStructuredDecision<T> {
  parsed: T;
  rawText: string | null;
}

export async function decide<Schema extends z.ZodType>(
  system: string,
  userContent: string,
  schema: Schema,
  context?: LLMCallContext,
): Promise<z.infer<Schema>> {
  try {
    return (await getLLMProvider().generateStructured(system, userContent, schema, context)).parsed;
  } catch (err) {
    if (err instanceof LLMNonRetryableError) throw err;
    console.warn(`decide() failed, retrying once: ${err instanceof Error ? err.message : String(err)}`);
    return (await getLLMProvider().generateStructured(system, userContent, schema, context)).parsed;
  }
}

export async function decideRaw<Schema extends z.ZodType>(
  system: string,
  userContent: string,
  schema: Schema,
  context?: LLMCallContext,
): Promise<RawStructuredDecision<z.infer<Schema>>> {
  try {
    const result = await getLLMProvider().generateStructured(system, userContent, schema, context);
    return { parsed: result.parsed, rawText: result.rawText ?? null };
  } catch (err) {
    if (err instanceof LLMNonRetryableError) throw err;
    console.warn(`decideRaw() failed, retrying once: ${err instanceof Error ? err.message : String(err)}`);
    const result = await getLLMProvider().generateStructured(system, userContent, schema, context);
    return { parsed: result.parsed, rawText: result.rawText ?? null };
  }
}
