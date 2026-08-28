import type { AgentType, CustomerMemoryProfile, RecoveryFrequencyRecord } from "../types/index.js";

// Bounded per-agent limit: once an agent has already granted this many
// discounts to the same customer (in this comparison run), it must stop
// negotiating and escalate instead — this is both the CLAUDE.md-required
// stopping rule and the payoff of gaming detection.
export const MAX_DISCOUNT_ATTEMPTS_PER_AGENT = 3;

// Cross-agent gaming: a customer who triggers cart abandonment twice,
// subscription recovery twice, and a dispute once (5 events total) is
// exploiting recovery flows just as much as one who triggers a single
// agent's flow 3+ times — but per-agent gamingSuspected below would never
// catch it, since no individual agent count crosses its own threshold.
// Deliberately a different number from MAX_DISCOUNT_ATTEMPTS_PER_AGENT so
// the two signals are distinguishable (and testable) as separate causes.
export const MAX_TOTAL_RECOVERY_EVENTS_ACROSS_AGENTS = 5;

// Composite churn signal: 2+ agents' triggering-event windows within this
// many days of each other. Matches how the synthetic generator plants the
// churn_signal scenario (events spread across a ~10-day window).
export const CHURN_WINDOW_DAYS = 14;

// How much a customer's dispute history should tighten discounting, ordered
// by severity. Adverse outranks unresolved; a history of nothing but WON
// disputes yields "none", because winning a chargeback is evidence about the
// merchant's delivery, not about the customer's trustworthiness.
export type DisputeCautionLevel = "none" | "unresolved" | "adverse";

export interface MemorySignals {
  // True at either caution level — kept as its own boolean so existing
  // consumers (the prompt block, the trace summary) stay a simple check.
  disputeCautionWarranted: boolean;
  disputeCautionLevel: DisputeCautionLevel;
  discountAttemptsForAgent: number;
  stoppingRuleHit: boolean;
  // "This one flow is being farmed" — this agent's own recovery event has
  // fired 3+ times for this customer.
  gamingSuspected: boolean;
  // "This customer is farming recovery flows in general" — a different,
  // broader signal: total recovery events summed across ALL agents, so a
  // customer spreading triggers across cart/subscription/dispute rather
  // than repeating one agent's flow still gets caught. Not a replacement
  // for gamingSuspected — both are exposed, since they're legitimately
  // different evidence.
  crossAgentGamingSuspected: boolean;
  compositeChurnSignal: boolean;
}

export function computeMemorySignals(profile: CustomerMemoryProfile, agent: AgentType): MemorySignals {
  const discountAttemptsForAgent = profile.discount_usage_history.filter((d) => d.agent === agent).length;
  const recoveryForAgent = profile.recovery_frequency.find((r) => r.agent === agent);
  // profile.recovery_frequency is already asOf-scoped (see profile.ts), so
  // summing it here stays causal for free — no separate DB query needed.
  const totalRecoveryEventsAcrossAgents = profile.recovery_frequency.reduce((sum, r) => sum + r.count, 0);

  const disputeCautionLevel = computeDisputeCautionLevel(profile);

  return {
    disputeCautionWarranted: disputeCautionLevel !== "none",
    disputeCautionLevel,
    discountAttemptsForAgent,
    stoppingRuleHit: discountAttemptsForAgent >= MAX_DISCOUNT_ATTEMPTS_PER_AGENT,
    gamingSuspected: (recoveryForAgent?.count ?? 0) >= MAX_DISCOUNT_ATTEMPTS_PER_AGENT,
    crossAgentGamingSuspected: totalRecoveryEventsAcrossAgents >= MAX_TOTAL_RECOVERY_EVENTS_ACROSS_AGENTS,
    compositeChurnSignal: hasCompositeChurnSignal(profile),
  };
}

// Deliberately NOT `dispute_count > 0`, which is what this used to be. That
// version suppressed the next discount for a customer who filed a legitimate
// dispute and won it — punishing them for the merchant's own failure to
// deliver. Only disputes that are adverse, or not yet resolved as of this
// read, are evidence about the customer.
function computeDisputeCautionLevel(profile: CustomerMemoryProfile): DisputeCautionLevel {
  const { adverse, unresolved } = profile.dispute_breakdown;
  if (adverse > 0) return "adverse";
  if (unresolved > 0) return "unresolved";
  return "none";
}

function hasCompositeChurnSignal(profile: CustomerMemoryProfile): boolean {
  const windows = profile.recovery_frequency;
  for (let i = 0; i < windows.length; i++) {
    for (let j = i + 1; j < windows.length; j++) {
      if (windowsWithinDays(windows[i]!, windows[j]!, CHURN_WINDOW_DAYS)) return true;
    }
  }
  return false;
}

function windowsWithinDays(a: RecoveryFrequencyRecord, b: RecoveryFrequencyRecord, days: number): boolean {
  const aStart = Date.parse(a.window_start);
  const aEnd = Date.parse(a.window_end);
  const bStart = Date.parse(b.window_start);
  const bEnd = Date.parse(b.window_end);
  // Gap between the two windows; <= 0 means they already overlap.
  const gapMs = Math.max(aStart - bEnd, bStart - aEnd);
  return gapMs <= days * 24 * 60 * 60 * 1000;
}
