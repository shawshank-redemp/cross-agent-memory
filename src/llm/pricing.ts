import type { LLMUsage } from "./provider.js";

export interface ModelPrice {
  inputPerMillionTokens: number;
  outputPerMillionTokens: number;
  cachedInputPerMillionTokens?: number;
  cacheWritePerMillionTokens?: number;
  notional?: boolean;
}

// Gemini 3.8 Flash Standard paid-tier rates, per Google Gemini Developer API
// pricing (https://ai.google.dev/gemini-api/docs/pricing), checked 2026-11-17.
// The free tier is $0; these rates show the notional paid-tier value of that
// usage through 2026-12-31, not an amount billed for free-tier calls.
export const MODEL_PRICES: Record<string, ModelPrice> = {
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
  "gemini-3.8-flash": {
    inputPerMillionTokens: 0.75,
    outputPerMillionTokens: 3.75,
    cachedInputPerMillionTokens: 0.075,
    notional: true,
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
