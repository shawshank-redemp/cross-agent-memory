import type { MemorySignals } from "../agents/policy.js";
import type { AgentType, CustomerMemoryProfile } from "../types/index.js";

// Per-agent experiment configuration. The engine that consumes this must stay
// agent-agnostic: nothing below the registry knows what a "discount" or a
// "cart" is, only opaque intervention ids and which memory signals gate them.
// Adding a fourth agent later is a registry entry, not an engine change.

export type InterventionId = string;

export interface InterventionSpec {
  id: InterventionId;
  // Exactly one intervention per experimentable agent is the control: the arm
  // where nothing is sent, so its outcome rate is the "would have converted
  // anyway" baseline the treatments are measured against.
  isControl: boolean;
  label: string;
}

// When `blockedWhen` is true on the customer's asOf memory signals, this one
// intervention is removed from the allowed list — the customer stays in the
// study on their remaining interventions. Per-intervention, not per-customer:
// a gaming-flagged customer is still informative about the exploiter
// population, we just refuse to spend margin on them to learn it.
export interface BlockRule {
  intervention: InterventionId;
  blockedWhen: keyof MemorySignals;
}

// Derives the moderator bucket from the customer's memory profile as of the
// triggering event. Named function rather than a signal key so a different
// agent can bucket on a different dimension entirely without widening
// MemorySignals with per-agent booleans.
export type BucketFn = (profile: CustomerMemoryProfile) => string;

export interface ExperimentableConfig {
  experimentable: true;
  experimentId: string;
  interventions: InterventionSpec[];
  blockRules: BlockRule[];
  // Signals that disqualify the customer from the experiment outright, as
  // opposed to blockRules which only narrow the allowed list. A different
  // concept: here no arm is acceptable, so there is nothing to randomise
  // between and the existing memory-informed path must run instead.
  excludeEntirelyWhen: (keyof MemorySignals)[];
  bucketSignal: BucketFn;
  // Agent-declared outcome keys. The evidence rollup stores these as an
  // opaque JSON object — a different agent cares about different outcomes,
  // so the engine must never assume cart's vocabulary.
  outcomeFields: string[];
}

export interface NonExperimentableConfig {
  experimentable: false;
  reason: string;
}

export type ExperimentConfig = ExperimentableConfig | NonExperimentableConfig;

// The moderator dimension for this build: one dimension, two buckets, split on
// whether ANY agent had already discounted this customer as of the triggering
// event. Reads straight off discount_usage_history, which profile.ts already
// scopes asOf, so the bucket cannot be contaminated by a discount that had not
// happened yet at decision time.
export function bucketByPriorDiscountHistory(profile: CustomerMemoryProfile): string {
  return profile.discount_usage_history.length > 0 ? "prior_discount" : "clean";
}

// A uniform discount percentage inside the discount arm. Letting Claude size
// the discount per customer would make the arm a mixture of Claude-chosen
// amounts, smuggling the very judgment the randomisation exists to isolate
// back into the treatment. Personalised sizing is a valid future arm to test
// AGAINST uniform sizing — it is not how this arm is built.
export const FIXED_DISCOUNT_PERCENT = 10;

// Deliberately absent: an "insufficient history" eligibility rule. Under asOf
// scoping every customer's first event sees an empty profile, so excluding
// thin profiles would exclude most of the dataset — including the clean
// bucket the moderator split depends on. Thin history is a bucket, not a
// disqualification.
export const EXPERIMENT_CONFIGS: Record<AgentType, ExperimentConfig> = {
  cart_abandonment: {
    experimentable: true,
    experimentId: "cart_recovery_v1",
    interventions: [
      { id: "no_action", isControl: true, label: "No action (control)" },
      { id: "send_reminder", isControl: false, label: "Reminder, no discount" },
      { id: "send_discount", isControl: false, label: `Reminder + ${FIXED_DISCOUNT_PERCENT}% discount` },
    ],
    blockRules: [
      { intervention: "send_discount", blockedWhen: "gamingSuspected" },
      { intervention: "send_discount", blockedWhen: "crossAgentGamingSuspected" },
      { intervention: "send_discount", blockedWhen: "stoppingRuleHit" },
    ],
    // Composite churn is a critical state: the memory layer's answer there is
    // escalate to a human, and that must not be overridden by a coin flip.
    excludeEntirelyWhen: ["compositeChurnSignal"],
    bucketSignal: bucketByPriorDiscountHistory,
    outcomeFields: ["recovered", "revenue_paise", "discount_cost_paise", "later_dispute"],
  },
  subscription_recovery: {
    experimentable: false,
    reason: "Deferred — valid control exists but not enabled for this build.",
  },
  dispute_responder: {
    experimentable: false,
    reason:
      "No valid control — every dispute requires handling, and randomising between conceding and contesting would concede disputes believed fraudulent to gather data.",
  },
};

export function getExperimentConfig(agent: AgentType): ExperimentConfig {
  return EXPERIMENT_CONFIGS[agent];
}
