import Anthropic, { AnthropicError } from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";

// Opus 5 is the default per Anthropic's current guidance; override with
// CLAUDE_MODEL only if you deliberately want to trade quality for cost on a
// large batch run — not a default this codebase picks for you.
const MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

export interface RawDecision<T> {
  parsed: T;
  // The model's literal output text, before JSON.parse. Field ORDER survives
  // only here — an object's key order is not something you can assert on after
  // parsing. Used by scripts/verifyFieldOrder.ts to confirm that structured
  // output really does emit fields in schema declaration order, which is what
  // makes "reasoning first" reasoning rather than post-hoc justification.
  rawText: string | null;
}

// --- Token accounting -------------------------------------------------------
//
// Accumulated per PROCESS, across every API call the run makes. The runner
// prints the totals and the real cost in its summary; nothing here alters a
// decision.
//
// Recorded inside decideOnceWithRaw rather than in decide(), because decide()
// retries once on failure and BOTH attempts are billed. Accounting at the
// wrapper would silently under-report every retried call.
//
// Recorded immediately on response, BEFORE the max_tokens and parsed_output
// checks below throw: a response that arrives and is then rejected has already
// consumed — and been charged for — its tokens.
export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

const usageTotals: UsageTotals = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
};

// cache_* are `number | null` on the SDK's Usage type; input/output are always
// numbers. The null coalescing is what the type requires, not defensiveness.
function recordUsage(usage: Anthropic.Usage): void {
  usageTotals.calls += 1;
  usageTotals.inputTokens += usage.input_tokens;
  usageTotals.outputTokens += usage.output_tokens;
  usageTotals.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
  usageTotals.cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
}

export function getUsageTotals(): UsageTotals {
  return { ...usageTotals };
}

// Which model the calls actually went to, so cost is priced against the model
// that ran rather than the one the code defaults to.
export function getModelInUse(): string {
  return MODEL;
}

async function decideOnceWithRaw<Schema extends z.ZodType>(
  system: string,
  userContent: string,
  schema: Schema,
): Promise<RawDecision<z.infer<Schema>>> {
  const response = await getClient().messages.parse({
    model: MODEL,
    // 1024 truncated mid-JSON-string on longer memory-informed reasoning
    // (a full batch run hit this at event 29) — 2048 leaves real headroom
    // over what we've observed (~250-400 word reasoning strings) while
    // still being far below the general 16000 default for a short
    // structured decision.
    max_tokens: 2048,
    // CACHED. The system prompt is now stable across every call for a given
    // agent — role, objective, action list, and the generated memory glossary —
    // because all per-customer content moved into the user message. Before that
    // move 62% of it varied per request (2,056 of 3,329 chars were this
    // customer's signal findings), and caching is a PREFIX match over
    // tools -> system -> messages, so no two requests shared a prefix past the
    // first third and a breakpoint here would have been worthless.
    //
    // The 5-minute default TTL is correct for this workload and not a
    // limitation: it is an INACTIVITY timer that a cache read refreshes for
    // free, and a batch run issues roughly one call a second across 3,440 calls,
    // so the entry never goes cold. The 1-hour TTL would only double the write
    // price for nothing.
    //
    // Whether it actually fires is a question for the data, not for this
    // comment: the stable prefix lands near the model-dependent minimum
    // cacheable size, so check getUsageTotals().cacheReadTokens after a run
    // rather than assuming. Those counters have existed all along and have been
    // reading zero, because nothing ever set cache_control until now.
    system: [{ type: "text" as const, text: system, cache_control: { type: "ephemeral" as const } }],
    messages: [{ role: "user", content: userContent }],
    output_config: { format: zodOutputFormat(schema) },
  });

  // Before any throw below: these tokens are billed whether or not we accept
  // the response.
  recordUsage(response.usage);

  if (response.stop_reason === "max_tokens") {
    throw new AnthropicError("Agent call hit max_tokens before finishing structured output");
  }
  if (!response.parsed_output) {
    throw new AnthropicError(
      `Agent call returned no parsed_output (stop_reason: ${response.stop_reason})`,
    );
  }

  const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  return { parsed: response.parsed_output, rawText: textBlock?.text ?? null };
}

async function decideOnce<Schema extends z.ZodType>(
  system: string,
  userContent: string,
  schema: Schema,
): Promise<z.infer<Schema>> {
  return (await decideOnceWithRaw(system, userContent, schema)).parsed;
}

// A single flaky/truncated/schema-invalid response (observed: one placeholder
// "reasoning" string in a 40-event run) shouldn't crash a 400+ event batch
// that's already made real progress — retry once before giving up.
export async function decide<Schema extends z.ZodType>(
  system: string,
  userContent: string,
  schema: Schema,
): Promise<z.infer<Schema>> {
  try {
    return await decideOnce(system, userContent, schema);
  } catch (err) {
    console.warn(`decide() failed, retrying once: ${err instanceof Error ? err.message : String(err)}`);
    return decideOnce(system, userContent, schema);
  }
}

// Same call, same single retry, but surfacing the raw text alongside the
// parsed object. Exists so field-order verification exercises the real
// production path rather than a lookalike replica of it.
export async function decideRaw<Schema extends z.ZodType>(
  system: string,
  userContent: string,
  schema: Schema,
): Promise<RawDecision<z.infer<Schema>>> {
  try {
    return await decideOnceWithRaw(system, userContent, schema);
  } catch (err) {
    console.warn(`decideRaw() failed, retrying once: ${err instanceof Error ? err.message : String(err)}`);
    return decideOnceWithRaw(system, userContent, schema);
  }
}

export { MODEL };
