// Provider and model for a compare run. Every arm in one run must use the same
// provider and model, or the comparison measures the provider, not the arm.
//
// The baseline and memory arms call the production LLM provider, selected by
// LLM_PROVIDER. The agentic arm calls ChatOllama directly. This guard resolves
// one configuration from the environment and refuses anything that would make
// the arms diverge: an unset or Anthropic provider, a non-Ollama provider, or
// a missing model.

export interface CompareConfig {
  provider: "ollama";
  model: string;
  baseUrl: string;
  pricingModel?: string;
}

export type CompareResolution =
  | { ok: true; config: CompareConfig }
  | { ok: false; message: string };

export function resolveCompareConfig(env: NodeJS.ProcessEnv): CompareResolution {
  const provider = env.LLM_PROVIDER?.trim();
  if (!provider) {
    return refuse(
      "LLM_PROVIDER is unset. Compare runs need LLM_PROVIDER=ollama. " +
        "The npm script sets it for you: npm run agents:agentic -- ...",
    );
  }
  if (provider === "anthropic") {
    return refuse(
      "LLM_PROVIDER=anthropic. Compare runs are local-only, and the agentic arm cannot run on " +
        "Anthropic. Set LLM_PROVIDER=ollama, or use the npm script, which sets it.",
    );
  }
  if (provider !== "ollama") {
    return refuse(`LLM_PROVIDER="${provider}" is not supported for compare runs. Use LLM_PROVIDER=ollama.`);
  }
  const model = env.OLLAMA_MODEL?.trim();
  if (!model) {
    return refuse("OLLAMA_MODEL is unset. Name the model every arm will use, for example OLLAMA_MODEL=qwen2.5:7b.");
  }
  return {
    ok: true,
    config: {
      provider: "ollama",
      model,
      baseUrl: env.OLLAMA_BASE_URL?.trim() || "http://localhost:11434",
      pricingModel: env.OLLAMA_PRICING_MODEL?.trim() || undefined,
    },
  };
}

function refuse(message: string): CompareResolution {
  return { ok: false, message: `refusing to run: ${message}` };
}
