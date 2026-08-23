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

export async function decide<Schema extends z.ZodType>(
  system: string,
  userContent: string,
  schema: Schema,
): Promise<z.infer<Schema>> {
  const response = await getClient().messages.parse({
    model: MODEL,
    max_tokens: 1024,
    system,
    messages: [{ role: "user", content: userContent }],
    output_config: { format: zodOutputFormat(schema) },
  });

  if (!response.parsed_output) {
    throw new AnthropicError(
      `Agent call returned no parsed_output (stop_reason: ${response.stop_reason})`,
    );
  }
  return response.parsed_output;
}

export { MODEL };
