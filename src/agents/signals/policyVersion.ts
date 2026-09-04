// WHICH POLICY produced a decision.
//
// audit_log already records the signals snapshot and the policy_override, but
// not the rules that turned one into the other. Change MIN_SUCCESSFUL_PAYMENTS
// from 2 to 3, or CHURN_LOOKBACK_DAYS from 14 to 30, and every historical row
// silently becomes uninterpretable: you can still see what the signals said,
// but not what the system did with them. For a payments audit trail, "why was
// this customer denied a discount in March" needs MARCH's policy, not today's.
import { createHash } from "node:crypto";
import { SIGNAL_REGISTRY } from "./registry.js";
import * as thresholds from "./thresholds.js";
import type { AnySignalDefinition } from "./types.js";

// Bump when policy BEHAVIOUR changes. That explicitly includes changes to a
// signal's effects() logic, which the hash below cannot see — see the note on
// THE GAP.
//
// Format is date-plus-counter so two bumps on the same day stay ordered.
// .2 bumped for the decide-stage rework. The thresholds hash moves on its own
// for ESCALATION_MIN_EVENT_AMOUNT_PAISE, but the prompt restructure is the part
// a hash cannot see: every signal now reports its measured magnitude instead of
// a bare boolean, per-case content moved out of the system prompt, and the field
// glossary is generated rather than hand-written. Decisions change; no threshold
// value does. That gap is exactly what this manual half exists for.
//
// .1 bumped for the Signals-stage rework: five signals renamed, two deleted
// (disputeCautionWarranted, paymentFriction), two added
// (crossAgentSpendLimitReached, pastDiscountsIneffective), `adverse` changed
// from a ceiling to a block, and blocking decoupled from escalating.
//
// The thresholds hash moves on its own for the constant changes. The manual
// half exists for what a hash cannot see, and this bump covers exactly that:
// effects() functions changed shape (a cap became a block; three brakes stopped
// escalating), which touches no threshold value and no signal id/scope/kind.
export const POLICY_VERSION = "2026-09-04.2";

// Canonical JSON: object keys sorted at every depth, no whitespace. The hash
// must not move when unrelated code changes, or it is worthless as a version —
// so serialisation cannot depend on declaration order, formatting, or the
// order a module happens to export things in.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

// What the hash covers: every numeric/structural knob in thresholds.ts, plus
// the shape of the registry (which signals exist, and what each one IS).
//
// Functions are skipped rather than stringified. Stringifying them would make
// the hash move on a comment edit or a reformat, which is the opposite of the
// stability this needs.
function buildPolicyShape(): Record<string, unknown> {
  const thresholdValues: Record<string, unknown> = {};
  for (const key of Object.keys(thresholds).sort()) {
    const value = (thresholds as Record<string, unknown>)[key];
    if (typeof value === "function") continue;
    thresholdValues[key] = value;
  }

  const signals = Object.entries(SIGNAL_REGISTRY as Record<string, AnySignalDefinition>)
    .map(([id, def]) => ({ id, scope: def.scope, kind: def.kind }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return { thresholds: thresholdValues, signals };
}

export function computePolicyThresholdsHash(shape: Record<string, unknown> = buildPolicyShape()): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(shape))).digest("hex").slice(0, 8);
}

export const POLICY_THRESHOLDS_HASH = computePolicyThresholdsHash();

// THE GAP, stated rather than glossed over: effects() are FUNCTIONS, and
// functions are not hashable in any way that is both meaningful and stable. A
// change to a signal's effect logic that touches neither a threshold value nor
// the signal id/scope/kind list will NOT move the hash.
//
// That is precisely what the manual POLICY_VERSION component is for, and why
// the fingerprint has two parts rather than just the hash: the hash catches
// what can be caught automatically, and the version covers what cannot. Neither
// alone is sufficient — a hash-only scheme would silently miss effect changes,
// and a version-only scheme relies entirely on someone remembering to bump it.
export const POLICY_FINGERPRINT = `${POLICY_VERSION}+${POLICY_THRESHOLDS_HASH}`;

// For `npm run policy:version` and the writeup.
export function describePolicy(): { version: string; hash: string; fingerprint: string; shape: Record<string, unknown> } {
  return {
    version: POLICY_VERSION,
    hash: POLICY_THRESHOLDS_HASH,
    fingerprint: POLICY_FINGERPRINT,
    shape: buildPolicyShape(),
  };
}

// Exported for the test that proves the hash actually responds to a threshold
// change, computed over a MUTATED COPY so the real constants are never touched.
export function policyShapeForTesting(): Record<string, unknown> {
  return buildPolicyShape();
}
