// THE SIGNAL REGISTRY — single source of truth for what a memory signal is,
// what it means, and what it does.
//
// ACCEPTANCE TEST FOR THIS DESIGN
// Adding a signal computed purely from facts CustomerMemoryProfile ALREADY
// exposes must be a SINGLE-FILE change, inside src/agents/signals/. No edit to
// the MemorySignals interface (it is derived from the registry, not written by
// hand), no edit to the prompt string (the policy block is generated from
// describe()), and no edit to enforcePolicy (it resolves effects() rather than
// testing hardcoded booleans).
//
// A signal that needs NEW facts additionally requires a profile.ts change.
// That split is deliberate, not an oversight: profile.ts answers "what is TRUE
// about this customer", and every asOf-scoped query lives there so temporal
// correctness is auditable in one place. The registry answers "what does that
// MEAN and what should we do about it". Mixing the two would scatter asOf
// scoping across every rule, which is how temporal-leakage bugs get in.
//
// This structure exists because adding a signal used to mean four disconnected
// edits — the interface, the compute function, the prompt string, and
// enforcePolicy's conditions — and nothing tied them together. That is how the
// churn-signal discount gap (commit 75f04a3) happened: enforcePolicy's
// conditions and the prompt's promises drifted apart.
import type { AgentType, CustomerMemoryProfile } from "../../types/index.js";
import { SIGNAL_DEFINITIONS } from "./definitions.js";
import { DEFAULT_DISCOUNT_CAP_PERCENT } from "./thresholds.js";
import type {
  AnySignalDefinition,
  DisputeCautionLevel,
  SignalContext,
  SignalEffects,
  SignalScope,
  TriggeringEventFacts,
} from "./types.js";

export const SIGNAL_REGISTRY = SIGNAL_DEFINITIONS;

export type SignalId = keyof typeof SIGNAL_REGISTRY;

// MemorySignals is DERIVED from the registry, never hand-maintained. Two
// hand-written lists would be two places to edit and would drift — which is
// the exact failure mode this refactor exists to prevent. `keyof
// MemorySignals` still resolves to the signal ids, so the experiment layer's
// blockRules / excludeEntirelyWhen keep compiling unchanged.
export type MemorySignals = {
  [K in SignalId]: ReturnType<(typeof SIGNAL_REGISTRY)[K]["compute"]>;
};

// REGRESSION GUARD. Every field the hand-written interface used to declare,
// with the same value type. If a future edit renames or retypes one of these
// in the registry, this stops compiling instead of silently breaking the
// dashboard, the audit rows, and the experiment layer's signal keys.
interface LegacyMemorySignalsShape {
  disputeCautionWarranted: boolean;
  disputeCautionLevel: DisputeCautionLevel;
  discountAttemptsForAgent: number;
  stoppingRuleHit: boolean;
  gamingSuspected: boolean;
  crossAgentGamingSuspected: boolean;
  compositeChurnSignal: boolean;
}
type AssertDerivedCoversLegacy = MemorySignals extends LegacyMemorySignalsShape ? true : never;
const _assertDerivedCoversLegacy: AssertDerivedCoversLegacy = true;
void _assertDerivedCoversLegacy;

// Each entry's `id` must match its key, since the id is what appears in audit
// rows and policy_override.triggered_by. Cheap to check, and a mismatch would
// be near-invisible otherwise.
for (const [key, def] of Object.entries(SIGNAL_REGISTRY as Record<string, AnySignalDefinition>)) {
  if (def.id !== key) {
    throw new Error(`Signal registry key "${key}" does not match its declared id "${def.id}".`);
  }
}

function entries(): [SignalId, AnySignalDefinition][] {
  return Object.entries(SIGNAL_REGISTRY) as [SignalId, AnySignalDefinition][];
}

// Signals of a given scope. Customer-scoped signals are true about the PERSON
// and are inherited unchanged by any new agent; agent-scoped signals are
// computed against the asking agent. Registering a fourth agent therefore
// means implementing only the agent-scoped ones — everything customer-scoped
// already applies.
export function signalsByScope(scope: SignalScope): AnySignalDefinition[] {
  return entries()
    .map(([, def]) => def)
    .filter((def) => def.scope === scope);
}

export function computeMemorySignals(
  profile: CustomerMemoryProfile,
  event: TriggeringEventFacts,
): MemorySignals {
  const ctx: SignalContext = { profile, agent: event.agent, event };
  const out = {} as Record<string, unknown>;
  for (const [id, def] of entries()) {
    out[id] = def.compute(ctx);
  }
  return out as MemorySignals;
}

export interface ResolvedEffects {
  blocksDiscount: boolean;
  forcesEscalation: boolean;
  discountCapPercent: number;
  // Which signals produced a blocking or escalating effect, by registry id.
  // Feeds policy_override.triggered_by.
  blockingSignals: SignalId[];
  escalatingSignals: SignalId[];
  // Which signal set the winning cap, for the audit trail.
  cappingSignal: SignalId | null;
}

// PRECEDENCE RULE: brakes beat accelerators, implemented by taking the MINIMUM
// cap across every ACTIVE signal. A proven payer who is also gaming gets 10%,
// not 25% — and no ordering of the registry can accidentally invert that,
// because minimum is commutative.
//
// DEFAULT_DISCOUNT_CAP_PERCENT is the fallback when nothing contributes, not a
// participant in the minimum. That distinction is what lets the accelerator
// work at all: with only provenPayer active the set is {25} and the cap is
// 25%, whereas folding the default in would give min(20, 25) = 20 and the
// accelerator could never do anything.
//
// A signal contributes only when its effects() returns a cap. An inactive
// boolean, or a dispute level that does not tighten below the default, returns
// {} — so merely being present can neither raise nor lower the ceiling.
export function resolveSignalEffects(signals: MemorySignals): ResolvedEffects {
  let blocksDiscount = false;
  let forcesEscalation = false;
  const blockingSignals: SignalId[] = [];
  const escalatingSignals: SignalId[] = [];
  const caps: { id: SignalId; percent: number }[] = [];

  for (const [id, def] of entries()) {
    const effects: SignalEffects = def.effects((signals as Record<string, unknown>)[id]);
    if (effects.blocksDiscount) {
      blocksDiscount = true;
      blockingSignals.push(id);
    }
    if (effects.forcesEscalation) {
      forcesEscalation = true;
      escalatingSignals.push(id);
    }
    if (effects.discountCapPercent != null) caps.push({ id, percent: effects.discountCapPercent });
  }

  const winner = caps.reduce<{ id: SignalId; percent: number } | null>(
    (lowest, c) => (lowest === null || c.percent < lowest.percent ? c : lowest),
    null,
  );

  return {
    blocksDiscount,
    forcesEscalation,
    discountCapPercent: winner?.percent ?? DEFAULT_DISCOUNT_CAP_PERCENT,
    blockingSignals,
    escalatingSignals,
    cappingSignal: winner?.id ?? null,
  };
}

// The policy block sent to the model, GENERATED from describe(). Prompt text
// and enforcement can no longer disagree, because both are read off the same
// registry entry.
//
// Only signals whose describe() returns non-null appear, so the block carries
// what actually applies to THIS customer instead of a standing lecture about
// every rule. The full signal values are still sent separately as
// policy_signals JSON.
export function buildSignalPolicyText(signals: MemorySignals): string {
  const lines: string[] = [];
  for (const [id, def] of entries()) {
    const text = def.describe((signals as Record<string, unknown>)[id]);
    if (text) lines.push(`- ${text}`);
  }
  if (lines.length === 0) {
    return `- No memory signal restricts this decision. The standing discount ceiling is ${DEFAULT_DISCOUNT_CAP_PERCENT}% of the event amount.`;
  }
  return lines.join("\n");
}

// Compact "which signals had something to say" summary, for the trace row.
// Registry-driven so a newly registered signal appears automatically. A signal
// counts as active exactly when its describe() returns text — the same
// definition the generated prompt uses, so trace and prompt never disagree.
export function summarizeActiveSignals(signals: MemorySignals): string {
  const active: string[] = [];
  for (const [id, def] of entries()) {
    const value = (signals as Record<string, unknown>)[id];
    if (def.describe(value) != null) active.push(`${id}=${String(value)}`);
  }
  return active.length > 0 ? active.join(", ") : "none";
}

export type { AgentType };
