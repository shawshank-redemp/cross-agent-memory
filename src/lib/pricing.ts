// Token pricing, in USD per MILLION tokens.
//
// One table, imported by both the pre-run projection (scripts/estimateRunCost.ts)
// and the post-run actual (agents/runner.ts). Two copies would let a projection
// and the reported real cost disagree while both looked authoritative.
//
// Prices are per model, because CLAUDE_MODEL is overridable and a run costed at
// Opus rates that actually executed on another model would report a confidently
// wrong number.

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

export const PRICING_BY_MODEL: Record<string, ModelPricing> = {
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
};

export const DEFAULT_PRICING_MODEL = "claude-opus-5";

// The Batch API is half price. NOTE: this run path does not use it, and cannot
// trivially — decisions within a customer are sequential, since
// discount_usage_history written by one decision feeds stoppingRuleHit on the
// next. Kept here only so the projection can show what batching would cost.
export const BATCH_DISCOUNT = 0.5;

// Returns null for a model with no published entry rather than guessing. The
// caller reports the token counts and says pricing is unavailable — a wrong
// dollar figure is worse than none.
export function pricingFor(model: string): ModelPricing | null {
  return PRICING_BY_MODEL[model] ?? null;
}

export function costUsd(inputTokens: number, outputTokens: number, pricing: ModelPricing): number {
  return (inputTokens * pricing.inputPerMTok + outputTokens * pricing.outputPerMTok) / 1_000_000;
}
