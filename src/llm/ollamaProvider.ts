import { z } from "zod";
import { LLMNonRetryableError, LLMResponseValidationError } from "./errors.js";
import type {
  LLMCallContext,
  LLMProvider,
  LLMStructuredOutput,
  LLMUsage,
} from "./provider.js";

// Local Ollama server. No API key, no cost: every call runs on this machine.
// Structured output uses Ollama's `format` field with a JSON Schema, so the
// model is constrained to the shape of the existing Zod decision schemas.
const DEFAULT_BASE_URL = "http://localhost:11434";
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_CALLS_PER_RUN = 100;
const VALIDATION_ATTEMPTS = 2;

export interface OllamaChatResponse {
  message?: { content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
  total_duration?: number;
  done?: boolean;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface OllamaProviderOptions {
  model?: string;
  baseUrl?: string;
  pricingModel?: string;
  timeoutMs?: number;
  maxCallsPerRun?: number;
  fetch?: FetchLike;
}

function readModel(): string {
  const model = process.env.OLLAMA_MODEL?.trim();
  if (!model) {
    throw new LLMNonRetryableError(
      "OLLAMA_MODEL is required when LLM_PROVIDER=ollama (e.g. OLLAMA_MODEL=qwen2.5:1.5b)",
    );
  }
  return model;
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer; received "${raw}"`);
  }
  return parsed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Ollama reports durations in nanoseconds. Usage is returned in the same shape
// as the other providers. Ollama has no prompt cache, so cachedTokens is 0.
export function usageFromOllama(
  response: OllamaChatResponse,
  model: string,
  latencyMs: number,
  pricingModel: string | undefined,
): LLMUsage {
  return {
    inputTokens: response.prompt_eval_count ?? 0,
    outputTokens: response.eval_count ?? 0,
    cachedTokens: 0,
    latencyMs,
    model,
    pricingModel,
  };
}

export class OllamaProvider implements LLMProvider {
  readonly name = "ollama";
  readonly model: string;
  readonly pricingModel: string | undefined;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxCallsPerRun: number;
  private readonly fetchImpl: FetchLike;
  private callsStarted = 0;

  constructor(options: OllamaProviderOptions = {}) {
    this.model = options.model ?? readModel();
    this.baseUrl = (options.baseUrl ?? process.env.OLLAMA_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    // Notional cost only. OLLAMA_PRICING_MODEL names a row in pricing.ts to
    // price this run against (e.g. gemini-3.8-flash). Unset means no notional
    // cost is reported, rather than a guessed one.
    this.pricingModel = options.pricingModel ?? (process.env.OLLAMA_PRICING_MODEL?.trim() || undefined);
    this.timeoutMs = options.timeoutMs ?? positiveIntegerEnv("OLLAMA_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
    this.maxCallsPerRun =
      options.maxCallsPerRun ?? positiveIntegerEnv("MAX_LLM_CALLS_PER_RUN", DEFAULT_MAX_CALLS_PER_RUN);
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
  }

  async generateStructured<Schema extends z.ZodType>(
    system: string,
    userContent: string,
    schema: Schema,
    context?: LLMCallContext,
  ): Promise<LLMStructuredOutput<z.infer<Schema>>> {
    let validationError = "Ollama returned no structured response";
    for (let attempt = 0; attempt < VALIDATION_ATTEMPTS; attempt += 1) {
      const { response, latencyMs } = await this.chat(system, userContent, schema);
      const usage = usageFromOllama(response, this.model, latencyMs, this.pricingModel);
      try {
        const text = response.message?.content;
        if (!text) throw new Error("Ollama response did not contain message content");
        const parsed = schema.parse(JSON.parse(text));
        context?.onAttempt?.({ usage, latencyMs });
        return { parsed, rawText: text, usage };
      } catch (error) {
        validationError = errorMessage(error);
        context?.onAttempt?.({ usage, latencyMs, error });
      }
    }
    throw new LLMResponseValidationError(
      `Ollama response failed Zod validation ${VALIDATION_ATTEMPTS} times for ${this.model}: ${validationError}`,
    );
  }

  private async chat(
    system: string,
    userContent: string,
    schema: z.ZodType,
  ): Promise<{ response: OllamaChatResponse; latencyMs: number }> {
    if (this.callsStarted >= this.maxCallsPerRun) {
      throw new LLMNonRetryableError(
        `MAX_LLM_CALLS_PER_RUN=${this.maxCallsPerRun} reached; refusing another Ollama request`,
      );
    }
    this.callsStarted += 1;

    const body = {
      model: this.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
      format: z.toJSONSchema(schema, { target: "draft-7" }),
      stream: false,
      // Deterministic decoding: the same prompt should give the same decision.
      options: { temperature: 0 },
    };

    const startedAt = Date.now();
    let httpResponse: Response;
    try {
      httpResponse = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // Connection refused means the server is not running: no point retrying.
      throw new LLMNonRetryableError(
        `Could not reach Ollama at ${this.baseUrl} (is \`ollama serve\` running?): ${errorMessage(error)}`,
      );
    }
    const latencyMs = Date.now() - startedAt;

    if (!httpResponse.ok) {
      const detail = await httpResponse.text().catch(() => "");
      throw new LLMNonRetryableError(
        `Ollama returned HTTP ${httpResponse.status} for model "${this.model}": ${detail.slice(0, 300)}`,
      );
    }
    const response = (await httpResponse.json()) as OllamaChatResponse;
    return { response, latencyMs };
  }
}

// Constructed on demand, not at import: the model comes from OLLAMA_MODEL, and
// importing this module must not fail for runs that use another provider.
export function createOllamaProvider(): OllamaProvider {
  return new OllamaProvider();
}
