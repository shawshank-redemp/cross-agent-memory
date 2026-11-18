import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Scenario } from "../data/generator.js";
import { recordInterventionOutcome } from "../memory/profile.js";
import { resolveRecoveryOutcome, rollsForEvent } from "../outcomes/resolveOutcomes.js";

// Records what an intervention achieved, for any arm, the same way the runner
// does (src/agents/runner.ts, "CLOSE THE FEEDBACK LOOP"):
//   - the outcome comes from resolveRecoveryOutcome, with rollsForEvent, so every
//     arm faces the same dice for the same event;
//   - the action recorded is the FINAL action after enforcement;
//   - only decided events are recorded. The runner's validation-fallback path
//     never reaches this step either.
//   - no scenario label means no outcome, as in the runner.
//
// The scenario is consulted here, in the outcome model, and never given to an agent.

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

export function loadScenarioByCustomer(): Map<string, Scenario> {
  try {
    const labels = JSON.parse(
      readFileSync(join(ROOT, "data", "generated", "scenario_labels.json"), "utf-8"),
    ) as Array<{ customer_id: string; scenario: Scenario }>;
    return new Map(labels.map((l) => [l.customer_id, l.scenario]));
  } catch {
    return new Map();
  }
}

export interface ArmOutcomeInput {
  mode: "baseline" | "memory" | "agentic";
  customerId: string;
  eventId: string;
  timestamp: string;
  grossAmountPaise: number;
  scenario: Scenario | undefined;
  decision: { action: string; committed_spend_paise: number | null; escalate_to_human: boolean };
}

export function recordArmOutcome(db: Database.Database, input: ArmOutcomeInput): boolean {
  if (!input.scenario) return false;
  const outcome = resolveRecoveryOutcome(
    input.eventId,
    "cart_abandonment",
    input.scenario,
    input.grossAmountPaise,
    {
      committed_spend_paise: input.decision.committed_spend_paise,
      escalate_to_human: input.decision.escalate_to_human,
    },
    rollsForEvent(input.eventId),
  );
  recordInterventionOutcome(db, {
    customerId: input.customerId,
    agent: "cart_abandonment",
    mode: input.mode,
    eventId: input.eventId,
    action: input.decision.action,
    committedSpendPaise: input.decision.committed_spend_paise,
    converted: outcome.paid === true,
    amountCollectedPaise: outcome.money_collected,
    decidedAt: input.timestamp,
  });
  return true;
}
