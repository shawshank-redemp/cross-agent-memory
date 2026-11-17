import type { z } from "zod";
import { anthropicProvider } from "./anthropicProvider.js";

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  latencyMs: number;
  model: string;
}

export interface LLMStructuredOutput<T> {
  parsed: T;
  usage: LLMUsage;
  rawText?: string | null;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  generateStructured<Schema extends z.ZodType>(
    system: string,
    userContent: string,
    schema: Schema,
  ): Promise<LLMStructuredOutput<z.infer<Schema>>>;
}

export function getLLMProvider(): LLMProvider {
  const providerName = process.env.LLM_PROVIDER ?? "anthropic";
  if (providerName !== "anthropic") {
    throw new Error(`Unsupported LLM_PROVIDER "${providerName}". Supported providers: anthropic`);
  }
  return anthropicProvider;
}

export interface RawStructuredDecision<T> {
  parsed: T;
  rawText: string | null;
}

export async function decide<Schema extends z.ZodType>(
  system: string,
  userContent: string,
  schema: Schema,
): Promise<z.infer<Schema>> {
  try {
    return (await getLLMProvider().generateStructured(system, userContent, schema)).parsed;
  } catch (err) {
    console.warn(`decide() failed, retrying once: ${err instanceof Error ? err.message : String(err)}`);
    return (await getLLMProvider().generateStructured(system, userContent, schema)).parsed;
  }
}

export async function decideRaw<Schema extends z.ZodType>(
  system: string,
  userContent: string,
  schema: Schema,
): Promise<RawStructuredDecision<z.infer<Schema>>> {
  try {
    const result = await getLLMProvider().generateStructured(system, userContent, schema);
    return { parsed: result.parsed, rawText: result.rawText ?? null };
  } catch (err) {
    console.warn(`decideRaw() failed, retrying once: ${err instanceof Error ? err.message : String(err)}`);
    const result = await getLLMProvider().generateStructured(system, userContent, schema);
    return { parsed: result.parsed, rawText: result.rawText ?? null };
  }
}
