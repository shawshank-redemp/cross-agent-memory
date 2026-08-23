CREATE TABLE IF NOT EXISTS customers (
  customer_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  contact TEXT NOT NULL,
  signup_date TEXT NOT NULL,
  plan_tier TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cart_abandonment_events (
  event_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  order_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  cart_value INTEGER NOT NULL,
  items INTEGER NOT NULL,
  channel TEXT NOT NULL,
  timestamp TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cart_events_customer ON cart_abandonment_events(customer_id);
CREATE INDEX IF NOT EXISTS idx_cart_events_order ON cart_abandonment_events(order_id);

CREATE TABLE IF NOT EXISTS subscription_failure_events (
  event_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  subscription_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  plan_amount INTEGER NOT NULL,
  cycle_number INTEGER NOT NULL,
  total_count INTEGER NOT NULL,
  failure_reason TEXT,
  status TEXT NOT NULL,
  timestamp TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sub_events_customer ON subscription_failure_events(customer_id);
CREATE INDEX IF NOT EXISTS idx_sub_events_subscription ON subscription_failure_events(subscription_id);

CREATE TABLE IF NOT EXISTS dispute_events (
  event_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  payment_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  dispute_reason TEXT NOT NULL,
  dispute_created_at TEXT NOT NULL,
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
  order_id TEXT,
  timestamp TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_discount_usage_customer ON discount_usage(customer_id);

-- Every memory read and every agent decision, graded requirement per
-- CLAUDE.md: what was read, what was decided, and why. `mode` distinguishes
-- baseline (no-memory) runs from memory-informed runs for the comparison in
-- step 5; `metadata` is a free-form JSON blob for decision-specific detail
-- (discount amount, triggering event_id, escalation flag, ...).
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  agent TEXT NOT NULL,
  mode TEXT CHECK (mode IN ('baseline', 'memory')),
  action TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_log_customer ON audit_log(customer_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_agent ON audit_log(agent);
