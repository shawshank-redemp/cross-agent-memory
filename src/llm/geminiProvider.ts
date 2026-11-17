import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { LLMNonRetryableError, LLMResponseValidationError } from "./errors.js";
import type {
  LLMCallContext,
  LLMProvider,
  LLMStructuredOutput,
  LLMUsage,
} from "./provider.js";

const DEFAULT_MODEL = "gemini-3.8-flash";
const DEFAULT_RPM = 5;
const DEFAULT_MAX_CALLS_PER_RUN = 100;
const MAX_429_RETRIES = 1;
const INITIAL_BACKOFF_MS = 500;
const REQUEST_TIMEOUT_MS = 90_000;

interface GeminiResponse {
  text?: string;
  usageMetadata?: {
    promptTokenCount?: number;
    cachedContentTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
}

interface GeminiRequest {
  model: string;
  contents: string;
  config: {
    systemInstruction: string;
    responseMimeType: "application/json";
    responseJsonSchema: unknown;
  };
}

interface GeminiClient {
  models: {
    generateContent(request: GeminiRequest): Promise<GeminiResponse>;
  };
}

interface RateLimiterOptions {
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class GeminiRequestLimiter {
  private nextRequestAt = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly requestsPerMinute: number,
    options: RateLimiterOptions = {},
  ) {
    if (!Number.isSafeInteger(requestsPerMinute) || requestsPerMinute < 1) {
      throw new Error(`GEMINI_RPM must be a positive integer; received ${requestsPerMinute}`);
    }
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async waitTurn(): Promise<void> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const delay = Math.max(0, this.nextRequestAt - this.now());
      if (delay > 0) await this.sleep(delay);
      this.nextRequestAt = Math.max(this.now(), this.nextRequestAt) + 60_000 / this.requestsPerMinute;
    } finally {
      release();
    }
  }
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer; received "${raw}"`);
  }
  return parsed;
}

function normalizeJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJsonSchema);
  if (value === null || typeof value !== "object") return value;
  const schema = value as Record<string, unknown>;

  if (Array.isArray(schema.anyOf)) {
    const variants = schema.anyOf;
    const nullable = variants.find(
      (variant) =>
        variant !== null &&
        typeof variant === "object" &&
        !Array.isArray(variant) &&
        (variant as Record<string, unknown>).type === "null",
    );
    const valueVariant = variants.find((variant) => variant !== nullable);
    if (nullable && valueVariant) {
      const normalized = normalizeJsonSchema(valueVariant);
      if (normalized && typeof normalized === "object" && !Array.isArray(normalized)) {
        return { ...(normalized as Record<string, unknown>), nullable: true };
      }
    }
    throw new Error("Gemini structured output does not support this Zod union schema");
  }

  const normalized: Record<string, unknown> = {};
  for (const key of ["type", "description", "enum", "required", "additionalProperties"]) {
    if (key in schema) normalized[key] = schema[key];
  }
  if (schema.properties && typeof schema.properties === "object") {
    normalized.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([key, property]) => [
        key,
        normalizeJsonSchema(property),
      ]),
    );
  }
  if ("items" in schema) normalized.items = normalizeJsonSchema(schema.items);
  return normalized;
}

export function zodToGeminiJsonSchema(schema: z.ZodType): unknown {
  return normalizeJsonSchema(z.toJSONSchema(schema, { target: "draft-7" }));
}

function statusCode(error: unknown): number | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const value = error as { status?: unknown; code?: unknown };
  if (typeof value.status === "number") return value.status;
  return typeof value.code === "number" ? value.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function usageFromResponse(response: GeminiResponse, model: string, latencyMs: number): LLMUsage {
  const metadata = response.usageMetadata;
  const cachedTokens = metadata?.cachedContentTokenCount ?? 0;
  return {
    inputTokens: Math.max(0, (metadata?.promptTokenCount ?? 0) - cachedTokens),
    outputTokens: (metadata?.candidatesTokenCount ?? 0) + (metadata?.thoughtsTokenCount ?? 0),
    cachedTokens,
    latencyMs,
    model,
  };
}

function readModel(): string {
  return process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
}

export interface GeminiProviderOptions {
  model?: string;
  requestsPerMinute?: number;
  maxCallsPerRun?: number;
  client?: GeminiClient;
  limiter?: GeminiRequestLimiter;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini";
  readonly model: string;
  private readonly limiter: GeminiRequestLimiter;
  private readonly maxCallsPerRun: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private client: GeminiClient | undefined;
  private callsStarted = 0;

  constructor(options: GeminiProviderOptions = {}) {
    this.model = options.model ?? readModel();
    this.maxCallsPerRun =
      options.maxCallsPerRun ?? positiveIntegerEnv("MAX_LLM_CALLS_PER_RUN", DEFAULT_MAX_CALLS_PER_RUN);
    this.limiter =
      options.limiter ??
      new GeminiRequestLimiter(
        options.requestsPerMinute ?? positiveIntegerEnv("GEMINI_RPM", DEFAULT_RPM),
      );
    this.sleep =
      options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.client = options.client;
  }

  async generateStructured<Schema extends z.ZodType>(
    system: string,
    userContent: string,
    schema: Schema,
    context?: LLMCallContext,
  ): Promise<LLMStructuredOutput<z.infer<Schema>>> {
    let validationError = "Gemini returned no structured response";
    for (let validationAttempt = 0; validationAttempt < 2; validationAttempt += 1) {
      const response = await this.generateContent(system, userContent, schema, context);
      const usage = usageFromResponse(response, this.model, response.latencyMs);
      try {
        if (!response.text) throw new Error("Gemini response did not contain text");
        const parsed = schema.parse(JSON.parse(response.text));
        context?.onAttempt?.({ usage, latencyMs: usage.latencyMs });
        return { parsed, rawText: response.text, usage };
      } catch (error) {
        validationError = errorMessage(error);
        context?.onAttempt?.({ usage, latencyMs: usage.latencyMs, error });
      }
    }
    throw new LLMResponseValidationError(
      `Gemini response failed Zod validation twice for ${this.model}: ${validationError}`,
    );
  }

  private async generateContent(
    system: string,
    userContent: string,
    schema: z.ZodType,
    context?: LLMCallContext,
  ): Promise<GeminiResponse & { latencyMs: number }> {
    const client = this.getClient();
    const request: GeminiRequest = {
      model: this.model,
      contents: userContent,
      config: {
        systemInstruction: system,
        responseMimeType: "application/json",
        responseJsonSchema: zodToGeminiJsonSchema(schema),
      },
    };

    for (let rateLimitRetry = 0; ; rateLimitRetry += 1) {
      if (this.callsStarted >= this.maxCallsPerRun) {
        throw new LLMNonRetryableError(
          `MAX_LLM_CALLS_PER_RUN=${this.maxCallsPerRun} reached; refusing another Gemini request`,
        );
      }
      await this.limiter.waitTurn();
      if (this.callsStarted >= this.maxCallsPerRun) {
        throw new LLMNonRetryableError(
          `MAX_LLM_CALLS_PER_RUN=${this.maxCallsPerRun} reached; refusing another Gemini request`,
        );
      }
      this.callsStarted += 1;
      const startedAt = Date.now();
      try {
        const result = await client.models.generateContent(request);
        return {
          text: result.text,
          usageMetadata: result.usageMetadata,
          latencyMs: Date.now() - startedAt,
        };
      } catch (error) {
        const latencyMs = Date.now() - startedAt;
        const message = errorMessage(error);
        context?.onAttempt?.({ latencyMs, error });
        if (/quota|daily limit|billing/i.test(message)) {
          throw new LLMNonRetryableError(`Gemini quota error; stopping without retry: ${message}`);
        }
        if (statusCode(error) !== 429) throw error;
        if (rateLimitRetry >= MAX_429_RETRIES) {
          throw new LLMNonRetryableError(
            `Gemini rate limit persisted after ${rateLimitRetry} bounded retries: ${message}`,
          );
        }
        await this.sleep(INITIAL_BACKOFF_MS * 2 ** rateLimitRetry);
      }
    }
  }

  private getClient(): GeminiClient {
    if (this.client) return this.client;
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new LLMNonRetryableError("GEMINI_API_KEY is required when LLM_PROVIDER=gemini");
    }
    const sdk = new GoogleGenAI({
      apiKey,
      httpOptions: {
        // A stalled request (observed: a 503 that never returned) must fail
        // into the bounded retry path, not hang the run indefinitely.
        timeout: REQUEST_TIMEOUT_MS,
        retryOptions: {
          attempts: 1,
          httpStatusCodes: [],
        },
      },
    });
    this.client = {
      models: {
        generateContent: (request) => sdk.models.generateContent(request),
      },
    };
    return this.client;
  }
}

export const geminiProvider = new GeminiProvider();
