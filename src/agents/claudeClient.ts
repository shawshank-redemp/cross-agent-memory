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

async function decideOnce<Schema extends z.ZodType>(
  system: string,
  userContent: string,
  schema: Schema,
): Promise<z.infer<Schema>> {
  const response = await getClient().messages.parse({
    model: MODEL,
    // 1024 truncated mid-JSON-string on longer memory-informed reasoning
    // (a full batch run hit this at event 29) — 2048 leaves real headroom
    // over what we've observed (~250-400 word reasoning strings) while
    // still being far below the general 16000 default for a short
    // structured decision.
    max_tokens: 2048,
    system,
    messages: [{ role: "user", content: userContent }],
    output_config: { format: zodOutputFormat(schema) },
  });

  if (response.stop_reason === "max_tokens") {
    throw new AnthropicError("Agent call hit max_tokens before finishing structured output");
  }
  if (!response.parsed_output) {
    throw new AnthropicError(
      `Agent call returned no parsed_output (stop_reason: ${response.stop_reason})`,
    );
  }
  return response.parsed_output;
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

export { MODEL };
