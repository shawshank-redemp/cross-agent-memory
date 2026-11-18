import type Database from "better-sqlite3";
import { POLICY_FINGERPRINT } from "../agents/policy.js";
import { appendAuditLog, recordDiscountUsage } from "../memory/profile.js";

// Writes one arm's decision the way the runner does (src/agents/runner.ts):
//   - a decision row in audit_log, mode-scoped;
//   - a discount_usage row when the decision commits spend.
// The decide functions for baseline and memory do neither. Only the runner does,
// so a compare run that calls them directly loses both. Without the discount row,
// the memory arm cannot read its own earlier discounts (its signals read
// discount_usage filtered by mode), and the audit row is what the report reads.
// Idempotent: both writes replace on (event_id, mode).
export interface ArmDecisionInput {
  mode: "baseline" | "memory";
  customerId: string;
  agent: "cart_abandonment";
  eventId: string;
  orderId: string;
  timestamp: string;
  decision: {
    action: string;
    reasoning: string;
    committed_spend_paise: number | null;
    escalate_to_human: boolean;
    escalation_reason?: string | null;
    memory_factors_used?: string[];
    unsupported_factor_citations?: string[];
    policy_override?: unknown;
  };
}

export function recordArmDecision(db: Database.Database, input: ArmDecisionInput): void {
  const d = input.decision;
  appendAuditLog(db, {
    customer_id: input.customerId,
    agent: input.agent,
    mode: input.mode,
    entry_type: "decision",
    event_id: input.eventId,
    action: d.action,
    reasoning: d.reasoning,
    escalate_to_human: d.escalate_to_human,
    policyVersion: POLICY_FINGERPRINT,
    policyOverride: (d.policy_override ?? null) as never,
    metadata: {
      // The runner names this discount_amount in metadata; the DB column names are unchanged.
      discount_amount: d.committed_spend_paise,
      committed_spend_paise: d.committed_spend_paise,
      memory_factors_used: d.memory_factors_used ?? [],
      escalation_reason: d.escalation_reason ?? null,
      unsupported_factor_citations: d.unsupported_factor_citations ?? [],
    },
    timestamp: input.timestamp,
  });
  if (d.committed_spend_paise != null) {
    recordDiscountUsage(db, {
      customer_id: input.customerId,
      agent: input.agent,
      mode: input.mode,
      amount: d.committed_spend_paise,
      event_id: input.eventId,
      order_id: input.orderId,
      timestamp: input.timestamp,
    });
  }
}
