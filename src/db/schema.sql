CREATE TABLE IF NOT EXISTS customers (
  customer_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  contact TEXT NOT NULL,
  signup_date TEXT NOT NULL,
  plan_tier TEXT NOT NULL
);

-- Mirrors a row of Razorpay's ORDERS report. One identifier per order, as a
-- real export has. amount/amount_paid/amount_due/attempts/notes/status are
-- all literal orders-report columns.
--
-- last_method / last_error_code / last_error_description are NOT orders
-- columns: they are the payments-report fields for this order's most recent
-- payment attempt, denormalised onto the order row. Real data Razorpay
-- already holds, one join away — recorded here as a flattened read model, not
-- invented. Invariants the generator upholds:
--   attempts = 0 (status 'created')   -> all three are NULL
--   attempts >= 1, status 'attempted' -> all three populated
--   attempts >= 1, status 'paid'      -> method set, both error fields NULL
CREATE TABLE IF NOT EXISTS cart_abandonment_events (
  order_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  amount INTEGER NOT NULL,
  amount_paid INTEGER NOT NULL,
  amount_due INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  last_method TEXT,
  last_error_code TEXT,
  last_error_description TEXT,
  notes TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cart_events_customer ON cart_abandonment_events(customer_id);

-- A subscription charge failure IS a failed payment, so the primary key is
-- the charge attempt (payment_id). subscription_id legitimately repeats
-- across billing cycles and could never be a key. paid_count/total_count are
-- Razorpay's own subscription columns (paid_count replaces the invented
-- `cycle_number`); method/error_code/error_description are the payments-report
-- fields, replacing the free-text `failure_reason`.
CREATE TABLE IF NOT EXISTS subscription_failure_events (
  payment_id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  plan_id TEXT NOT NULL,
  plan_amount INTEGER NOT NULL,
  plan_period TEXT NOT NULL,
  plan_interval INTEGER NOT NULL,
  paid_count INTEGER NOT NULL,
  total_count INTEGER NOT NULL,
  status TEXT NOT NULL,
  method TEXT NOT NULL,
  error_code TEXT,
  error_description TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sub_events_customer ON subscription_failure_events(customer_id);
CREATE INDEX IF NOT EXISTS idx_sub_events_subscription ON subscription_failure_events(subscription_id);

-- resolved_at is the "when did we learn the outcome" timestamp. Without it,
-- reading `status` alone leaks a future ruling backwards into a past
-- decision: a dispute filed before an event and won after it would make the
-- earlier decision look informed by an outcome that had not happened yet.
-- NULL while open/under_review; strictly after dispute_created_at otherwise.
CREATE TABLE IF NOT EXISTS dispute_events (
  dispute_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  payment_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  dispute_reason TEXT NOT NULL,
  dispute_created_at TEXT NOT NULL,
  resolved_at TEXT,
  status TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dispute_events_customer ON dispute_events(customer_id);
CREATE INDEX IF NOT EXISTS idx_dispute_events_order ON dispute_events(order_id);

-- Raw fact: a discount an agent actually granted. Part of the memory
-- profile's discount_usage_history; populated by agent decision logic.
-- `mode` scopes this to one comparison run (baseline vs memory) — without
-- it, discounts granted during the no-memory baseline run would leak into
-- the memory-informed run's profile reads, contaminating the step-5
-- baseline-vs-memory comparison into one timeline instead of two.
CREATE TABLE IF NOT EXISTS discount_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  agent TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('baseline', 'memory')),
  amount INTEGER NOT NULL,
  -- The triggering event's own id, whatever table it came from (order_id /
  -- payment_id / dispute_id, normalised at the TaggedEvent boundary).
  -- order_id below is NULL for subscription and dispute events, so without
  -- this a discount could not be traced back to its cause in two of the
  -- three domains.
  event_id TEXT NOT NULL,
  order_id TEXT,
  timestamp TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_discount_usage_customer ON discount_usage(customer_id);

-- IDEMPOTENCY. One event decided once per arm grants at most one discount.
-- The normal pipeline is self-cleaning (load:data deletes this table before
-- each load), so duplicates only arise when agents:memory is re-run WITHOUT
-- reloading — which the runner's --resume flag makes routine.
--
-- The index is paired with an ON CONFLICT DO UPDATE in recordDiscountUsage.
-- A BARE unique index would be a downgrade, not a fix: it would convert silent
-- duplication into a hard mid-run insert crash on the retry path that exists
-- precisely to recover from crashes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_discount_usage_event_mode ON discount_usage(event_id, mode);

-- THE FEEDBACK LOOP. One row per intervention: what we did, and whether it
-- worked. Every other table records what the CUSTOMER did; this is the only
-- one that records what WE did and how it turned out, which is what lets a
-- later decision learn "discounts do not work on this person".
--
-- NOT discount-specific. `action` holds the agent's own final action string,
-- so a reminder, a retry, an escalation and a discount are all recorded the
-- same way and a fourth agent records its own actions with no schema change.
--
-- TWO TIMESTAMPS, and the distinction is the point. decided_at is when we
-- acted. observed_at is when the result became knowable — decided_at plus
-- INTERVENTION_OBSERVATION_LAG_DAYS, because a customer does not pay the
-- instant an offer is sent. Profile reads filter on observed_at, never
-- decided_at: writing the result at decision time would let the very next
-- decision on that customer read an outcome that had not happened yet, the
-- same temporal leak already fixed for dispute resolved_at.
--
-- `mode` scopes this to one comparison arm, exactly as on discount_usage: a
-- memory-informed read must not see the baseline run's outcomes as its own.
CREATE TABLE IF NOT EXISTS intervention_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  agent TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('baseline', 'memory')),
  event_id TEXT NOT NULL,
  action TEXT NOT NULL,
  committed_spend_paise INTEGER,
  converted INTEGER NOT NULL CHECK (converted IN (0, 1)),
  amount_collected_paise INTEGER NOT NULL,
  decided_at TEXT NOT NULL,
  observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_intervention_outcomes_customer
  ON intervention_outcomes(customer_id, mode);
-- Same idempotency guarantee as discount_usage, paired with the
-- ON CONFLICT DO UPDATE in recordInterventionOutcome, so --resume and
-- re-decides replace rather than duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_intervention_outcomes_event_mode
  ON intervention_outcomes(event_id, mode);

-- Graded requirement per CLAUDE.md. `mode` distinguishes baseline
-- (no-memory) runs from memory-informed runs for the comparison in step 5.
-- Every memory read and every agent decision: what was read, what was
-- decided, and why. The rule for what is a column vs what lives in
-- `metadata`: columns for what gets filtered or joined on, JSON for what is
-- only ever displayed.
--
-- entry_type replaces the `action != 'read_memory_profile'` string
-- comparison the recent-decisions view used to rely on.
--
-- signals is the MemorySignals snapshot the decision was made against, and
-- policy_override records what the model originally wanted plus which rules
-- overrode it. Together they make "the LLM proposes, deterministic code
-- disposes" readable straight off the data instead of merely asserted.
--
-- A policy_override with a NULL `signals` value is coherent, not a bug: the
-- UNIVERSAL policy layer (spend bounds, action/spend coherence, the default
-- ceiling) runs on BOTH arms, so a baseline row can carry an override even
-- though baseline has no memory from which to compute signals. Only
-- memory-derived overrides — tightened caps, blocks, forced escalation — carry
-- a signals snapshot alongside.
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  agent TEXT NOT NULL,
  mode TEXT CHECK (mode IN ('baseline', 'memory')),
  entry_type TEXT NOT NULL CHECK (entry_type IN ('memory_read', 'decision')),
  event_id TEXT,
  action TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  -- NULL on a memory_read row: reading memory decides nothing.
  escalate_to_human INTEGER CHECK (escalate_to_human IN (0, 1)),
  -- WHICH policy produced this decision: POLICY_VERSION + a hash of the
  -- thresholds and registry shape (see signals/policyVersion.ts). Without it,
  -- changing a threshold makes every historical row uninterpretable — the
  -- signals are still visible but the rules that acted on them are not.
  -- NULL on memory_read rows for the same reason escalate_to_human is: a read
  -- decides nothing, so no policy governed it.
  policy_version TEXT,
  signals TEXT,
  policy_override TEXT,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_log_customer ON audit_log(customer_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_agent ON audit_log(agent);
CREATE INDEX IF NOT EXISTS idx_audit_log_event ON audit_log(event_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_entry_type ON audit_log(entry_type);

-- Same idempotency guarantee for the decision/memory_read rows, paired with an
-- ON CONFLICT DO UPDATE in appendAuditLog. entry_type is part of the key because
-- one event legitimately produces BOTH a memory_read and a decision row.
--
-- event_id is nullable, and SQLite treats each NULL as distinct in a unique
-- index, so cross-cutting rows that carry no event_id are unaffected and can
-- still be appended freely.
CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_log_event_mode_type
  ON audit_log(event_id, mode, entry_type);

-- Stage 1 live-replay trace: granular step-by-step record of what a
-- decideWithMemory (or baseline decide()) call actually did, separate from
-- audit_log's one-row-per-decision summary. Powers the frontend's
-- step-by-step replay view.
CREATE TABLE IF NOT EXISTS agent_trace_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  event_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('baseline', 'memory')),
  step_order INTEGER NOT NULL,
  step_name TEXT NOT NULL,
  detail TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  started_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trace_events_lookup ON agent_trace_events(customer_id, event_id, mode);

-- One row per enrolled customer-event: what the coin was choosing between,
-- what it chose, and what the agent would have chosen if asked. The witness
-- columns (agent_preferred_*) are the point of the table as much as the
-- assignment is — "agent wanted to spend, coin said don't, customer converted
-- anyway" is only visible if the discarded free choice is kept.
-- allowed_interventions is stored per-row because eligibility is computed asOf
-- and so varies by event; without it a result cell can't be interpreted later.
-- Deliberately no `mode` column, unlike discount_usage and audit_log: the
-- experiment only ever runs on the memory-informed path, so a mode would be a
-- constant pretending to be a dimension.
CREATE TABLE IF NOT EXISTS experiment_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  event_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  experiment_id TEXT NOT NULL,
  assigned_intervention TEXT NOT NULL,
  allowed_interventions TEXT NOT NULL,
  bucket TEXT NOT NULL,
  agent_preferred_intervention TEXT,
  agent_preferred_reasoning TEXT,
  assigned_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_experiment_assignments_cell
  ON experiment_assignments(experiment_id, bucket, assigned_intervention);

-- Aggregated rollup, one row per (experiment, bucket, intervention) cell —
-- the comparable unit an incrementality claim is read off. `outcomes` is a
-- JSON object keyed by the agent's own declared outcomeFields rather than
-- typed columns: a per-outcome column set would bake cart abandonment's
-- worldview (recovered/revenue/discount cost) into a schema a future agent
-- with different outcomes has to share.
CREATE TABLE IF NOT EXISTS experiment_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  experiment_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  bucket TEXT NOT NULL,
  intervention TEXT NOT NULL,
  n INTEGER NOT NULL,
  outcomes TEXT NOT NULL,
  computed_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_experiment_evidence_cell
  ON experiment_evidence(experiment_id, bucket, intervention);
