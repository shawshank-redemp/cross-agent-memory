import type Database from "better-sqlite3";
import type { z } from "zod";
import { getMemoryProfile } from "../memory/profile.js";
import type { AgentType, Customer } from "../types/index.js";
import { decide } from "./claudeClient.js";
import { computeMemorySignals, type MemorySignals } from "./policy.js";

export const MEMORY_POLICY_BLOCK = `
You also have this customer's shared memory profile, aggregated across ALL
of Razorpay's recovery agents (Cart Abandonment, Subscription Recovery,
Dispute Responder) — not just your own agent's past interactions with them:

- dispute_count / total_disputed_amount: disputes this customer has filed,
  and for how much.
- rolling_health_score (0-100, lower = riskier): a composite risk score.
- discount_usage_history: every discount ANY agent has already granted this
  customer in this run.
- recovery_frequency: how many times each agent's triggering event has
  fired for this customer, and over what time window.
- recent_decisions: the last few decisions any agent made for this customer,
  with their reasoning.

You are also given precomputed policy_signals — treat these as hard
constraints, not suggestions:
- dispute_caution_warranted: this customer has at least one dispute on
  record. If true, cap any discount at 10% of cart_value/plan_amount
  instead of the usual 20%, and prefer a plain nudge over a discount unless
  the amount involved is small.
- stopping_rule_hit: this agent has already granted 3+ discounts to this
  customer in this run. If true, you MUST NOT grant another discount.
- gaming_suspected: this customer has triggered this agent's recovery flow
  3+ times — a pattern consistent with exploiting the discount nudge rather
  than genuine difficulty paying. If true, you MUST NOT grant another
  discount and MUST set escalate_to_human=true, and say so explicitly.
- composite_churn_signal: 2+ of this customer's recovery flows
  (cart/subscription/dispute) have fired within roughly a two-week window —
  a real churn risk that another automated nudge won't fix. If true, you
  MUST set escalate_to_human=true regardless of your other reasoning.

In your reasoning, say what you read from memory and how it changed (or
didn't change) your decision versus having no history at all.`;

interface MemoryDecisionShape {
  action: string;
  discount_amount: number | null;
  escalate_to_human: boolean;
  reasoning: string;
}

export interface DecideWithMemoryParams<Schema extends z.ZodType<MemoryDecisionShape>> {
  db: Database.Database;
  customer: Customer;
  agent: AgentType;
  event: unknown;
  systemPrompt: string;
  schema: Schema;
  fallbackNonDiscountAction: z.infer<Schema>["action"];
  memoryReadReason: string;
}

export async function decideWithMemory<Schema extends z.ZodType<MemoryDecisionShape>>(
  params: DecideWithMemoryParams<Schema>,
): Promise<z.infer<Schema>> {
  const profile = getMemoryProfile(params.db, params.customer.customer_id, {
    requestedBy: params.agent,
    mode: "memory",
    reason: params.memoryReadReason,
  });
  const signals = computeMemorySignals(profile, params.agent);

  const recentDecisions = profile.audit_log.filter((e) => e.action !== "read_memory_profile").slice(-5);
  const userContent = JSON.stringify(
    {
      customer: params.customer,
      event: params.event,
      memory_profile: {
        dispute_count: profile.dispute_count,
        total_disputed_amount: profile.total_disputed_amount,
        rolling_health_score: profile.rolling_health_score,
        discount_usage_history: profile.discount_usage_history,
        recovery_frequency: profile.recovery_frequency,
        recent_decisions: recentDecisions,
      },
      policy_signals: signals,
    },
    null,
    2,
  );

  const decision = await decide(`${params.systemPrompt}\n${MEMORY_POLICY_BLOCK}`, userContent, params.schema);
  return enforcePolicy(decision, signals, params.fallbackNonDiscountAction);
}

// Safety net: an LLM call is not a reliable place to enforce a hard, bounded
// limit — the stopping rule and churn escalation are deterministic
// overrides, applied here regardless of what the model returned, with the
// original reasoning preserved and the override noted for the audit trail.
function enforcePolicy<D extends MemoryDecisionShape>(decision: D, signals: MemorySignals, fallbackNonDiscountAction: D["action"]): D {
  const mustBlockDiscount = (signals.stoppingRuleHit || signals.gamingSuspected) && decision.discount_amount != null;
  const mustEscalate = (signals.gamingSuspected || signals.compositeChurnSignal) && !decision.escalate_to_human;

  if (!mustBlockDiscount && !mustEscalate) return decision;

  const notes: string[] = [];
  if (mustBlockDiscount) notes.push("stopping-rule/gaming signal forbids another discount here");
  if (mustEscalate) notes.push("gaming or composite-churn signal requires escalation");

  return {
    ...decision,
    action: mustBlockDiscount ? fallbackNonDiscountAction : decision.action,
    discount_amount: mustBlockDiscount ? null : decision.discount_amount,
    escalate_to_human: true,
    reasoning: `${decision.reasoning}\n\n[POLICY OVERRIDE] ${notes.join("; ")}.`,
  };
}
