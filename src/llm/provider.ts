import type Database from "better-sqlite3";
import type { z } from "zod";
import type { AgentType } from "../types/index.js";
import { anthropicProvider } from "./anthropicProvider.js";
import { instrumentProvider } from "./instrumentedProvider.js";

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  latencyMs: number;
  model: string;
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
  mode: "baseline" | "memory";
  stepType: string;
  traceId?: string;
  parentSpanId?: string | null;
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
  if (providerName !== "anthropic") {
    throw new Error(`Unsupported LLM_PROVIDER "${providerName}". Supported providers: anthropic`);
  }
  const key = `${anthropicProvider.name}:${anthropicProvider.model}`;
  if (!instrumentedProvider || instrumentedProviderKey !== key) {
    instrumentedProvider = instrumentProvider(anthropicProvider);
    instrumentedProviderKey = key;
  }
  return instrumentedProvider;
}

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
    console.warn(`decideRaw() failed, retrying once: ${err instanceof Error ? err.message : String(err)}`);
    const result = await getLLMProvider().generateStructured(system, userContent, schema, context);
    return { parsed: result.parsed, rawText: result.rawText ?? null };
  }
}
