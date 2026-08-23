import type { AgentType, CustomerMemoryProfile, RecoveryFrequencyRecord } from "../types/index.js";

// Bounded per-agent limit: once an agent has already granted this many
// discounts to the same customer (in this comparison run), it must stop
// negotiating and escalate instead — this is both the CLAUDE.md-required
// stopping rule and the payoff of gaming detection.
export const MAX_DISCOUNT_ATTEMPTS_PER_AGENT = 3;

// Composite churn signal: 2+ agents' triggering-event windows within this
// many days of each other. Matches how the synthetic generator plants the
// churn_signal scenario (events spread across a ~10-day window).
export const CHURN_WINDOW_DAYS = 14;

export interface MemorySignals {
  disputeCautionWarranted: boolean;
  discountAttemptsForAgent: number;
  stoppingRuleHit: boolean;
  gamingSuspected: boolean;
  compositeChurnSignal: boolean;
}

export function computeMemorySignals(profile: CustomerMemoryProfile, agent: AgentType): MemorySignals {
  const discountAttemptsForAgent = profile.discount_usage_history.filter((d) => d.agent === agent).length;
  const recoveryForAgent = profile.recovery_frequency.find((r) => r.agent === agent);

  return {
    disputeCautionWarranted: profile.dispute_count > 0,
    discountAttemptsForAgent,
    stoppingRuleHit: discountAttemptsForAgent >= MAX_DISCOUNT_ATTEMPTS_PER_AGENT,
    gamingSuspected: (recoveryForAgent?.count ?? 0) >= MAX_DISCOUNT_ATTEMPTS_PER_AGENT,
    compositeChurnSignal: hasCompositeChurnSignal(profile),
  };
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
