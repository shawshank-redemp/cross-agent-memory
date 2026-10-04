import type { AgentType } from "./events.js";

// Row shapes for the experimentation layer's two tables (see db/schema.sql).
// JSON-encoded columns are typed as the parsed shape's string form here —
// callers own the JSON.parse, same as audit_log's `metadata`.

// One enrolled customer-event. `allowed_interventions` is a JSON array of
// intervention ids: what the coin was choosing between at that moment, which
// varies event-to-event because eligibility is computed asOf.
export interface ExperimentAssignmentRow {
  id: number;
  customer_id: string;
  event_id: string;
  agent: AgentType;
  experiment_id: string;
  assigned_intervention: string;
  allowed_interventions: string; // JSON string[]
  bucket: string;
  // The witness call: what the agent would have chosen on its own, recorded
  // and then discarded in favour of the coin. Null when no witness call was
  // made for this assignment.
  agent_preferred_intervention: string | null;
  agent_preferred_reasoning: string | null;
  assigned_at: string;
}

// One aggregated (experiment, bucket, intervention) cell. `outcomes` is a JSON
// object keyed by the agent's own declared outcomeFields — intentionally
// untyped per-agent so the schema stays agent-agnostic.
export interface ExperimentEvidenceRow {
  id: number;
  experiment_id: string;
  agent: AgentType;
  bucket: string;
  intervention: string;
  n: number;
  outcomes: string; // JSON Record<string, number>
  computed_at: string;
}
