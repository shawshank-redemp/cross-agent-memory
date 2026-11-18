import { openDb } from "../db/connection.js";
import { MODEL_PRICES } from "../llm/pricing.js";

interface MetricRow {
  agent: string;
  mode: "baseline" | "memory";
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cache_write_tokens: number;
  latency_ms: number;
  tokens_per_second: number;
  cost_usd: number | null;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
}

function main(): void {
  const db = openDb();
  const rows = db
    .prepare(
      `SELECT agent, mode, model, input_tokens, output_tokens, cached_tokens, cache_write_tokens,
              latency_ms, tokens_per_second, cost_usd
       FROM llm_call_metrics
       ORDER BY agent, mode`,
    )
    .all() as MetricRow[];
  db.close();

  if (rows.length === 0) {
    console.log("No LLM call metrics recorded. Run an agent flow first.");
    return;
  }

  const groups = new Map<string, MetricRow[]>();
  for (const row of rows) {
    const key = `${row.agent}|${row.mode}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  console.log("LLM metrics by agent and arm");
  // Any priced row is notional: free-tier Gemini and local Ollama calls cost $0,
  // and the amount shown is what the same usage would cost at the paid-tier rate
  // named in src/llm/pricing.ts. Ollama rows reach this path through
  // OLLAMA_PRICING_MODEL, so their model name does not appear in MODEL_PRICES;
  // checking the model name alone is what left them unlabelled.
  if (rows.some((row) => row.cost_usd !== null)) {
    console.log(
      "Costs are NOTIONAL. Gemini free-tier and local Ollama calls cost $0; the amounts below are " +
        "what the same usage would cost at the paid-tier rates in src/llm/pricing.ts.",
    );
  }
  console.log(
    "agent | arm | models | calls | total tokens (in/out) | avg tokens/call | cached/read-write tokens | " +
      "cost/request USD (notional where marked) | p50/p95 latency ms | avg output tokens/sec",
  );
  for (const [key, group] of groups) {
    const [agent, mode] = key.split("|") as [string, string];
    const calls = group.length;
    const models = [...new Set(group.map((row) => row.model))].sort();
    const inputTokens = group.reduce((sum, row) => sum + row.input_tokens, 0);
    const outputTokens = group.reduce((sum, row) => sum + row.output_tokens, 0);
    const cachedTokens = group.reduce((sum, row) => sum + row.cached_tokens, 0);
    const cacheWriteTokens = group.reduce((sum, row) => sum + row.cache_write_tokens, 0);
    const priced = group.filter((row) => row.cost_usd !== null);
    const costPerRequest =
      priced.length === calls
        ? `${priced.length > 0 ? "notional " : ""}` +
          `$${(priced.reduce((sum, row) => sum + row.cost_usd!, 0) / calls).toFixed(6)}`
        : `n/a (${calls - priced.length} unpriced)`;
    const latencies = group.map((row) => row.latency_ms);
    const avgTokensPerSecond =
      group.reduce((sum, row) => sum + row.tokens_per_second, 0) / calls;
    console.log(
      `${agent} | ${mode} | ${models.join(",")} | ${calls} | ${inputTokens}/${outputTokens} | ` +
        `${((inputTokens + outputTokens) / calls).toFixed(1)} | ${cachedTokens}/${cacheWriteTokens} | ` +
        `${costPerRequest} | ${percentile(latencies, 0.5)}/${percentile(latencies, 0.95)} | ` +
        `${avgTokensPerSecond.toFixed(1)}`,
    );
  }
}

main();
