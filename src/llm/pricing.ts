import type { LLMUsage } from "./provider.js";

export interface ModelPrice {
  inputPerMillionTokens: number;
  outputPerMillionTokens: number;
  cachedInputPerMillionTokens?: number;
  cacheWritePerMillionTokens?: number;
  notional?: boolean;
}

// NOTIONAL PRICING FOR GEMINI. Gemini free-tier calls are billed at $0. These
// rates are what the same usage would cost on the PAID Standard tier, so that
// run metrics stay comparable across providers. They are not money spent.
// Source: Gemini API pricing, Standard tier, gemini-3.8-flash, text input/output
//   https://aistudio.google.com/docs/pricing (reached via ai.google.dev/gemini-api/docs/pricing)
// Retrieved: 2026-11-17. Output price includes thinking tokens.
// Price change: from 2027-01-01 the page lists $1.50 input / $7.50 output /
//   $0.15 cached per 1M tokens. Update this entry (or add a dated entry) then.
// Cache storage (billed per token-hour) is not modelled; cache writes are 0 for Gemini.
export const MODEL_PRICES: Record<string, ModelPrice> = {
  "gemini-3.8-flash": {
    inputPerMillionTokens: 0.75,
    outputPerMillionTokens: 3.75,
    cachedInputPerMillionTokens: 0.075,
    notional: true,
  },
  "claude-opus-5": {
    inputPerMillionTokens: 5,
    outputPerMillionTokens: 25,
    cachedInputPerMillionTokens: 0.5,
    cacheWritePerMillionTokens: 6.25,
  },
  "mock-decision-v1": {
    inputPerMillionTokens: 0,
    outputPerMillionTokens: 0,
    cachedInputPerMillionTokens: 0,
    cacheWritePerMillionTokens: 0,
  },
};

export function computeCost(
  usage: Pick<
    LLMUsage,
    "inputTokens" | "outputTokens" | "cachedTokens" | "cacheWriteTokens" | "batchDiscount"
  >,
  model: string,
): number | null {
  const price = MODEL_PRICES[model];
  if (!price) return null;
  const cachedTokens = usage.cachedTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  if (
    (cachedTokens > 0 && price.cachedInputPerMillionTokens === undefined) ||
    (cacheWriteTokens > 0 && price.cacheWritePerMillionTokens === undefined)
  ) {
    return null;
  }
  const undiscountedCost = (
    (usage.inputTokens * price.inputPerMillionTokens +
      usage.outputTokens * price.outputPerMillionTokens +
      cachedTokens * (price.cachedInputPerMillionTokens ?? 0) +
      cacheWriteTokens * (price.cacheWritePerMillionTokens ?? 0)) /
    1_000_000
  );
  return undiscountedCost * (1 - (usage.batchDiscount ?? 0));
}
