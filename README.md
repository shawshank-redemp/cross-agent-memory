# cross-agent-memory

Razorpay AI Buildathon submission — Track 03: AI Revenue Recovery.

A shared customer memory layer sitting above point-agents (Cart Abandonment,
Subscription Recovery, Dispute Responder) so each agent's decisions are
informed by what the others already know about a customer. See
[CLAUDE.md](./CLAUDE.md) for the full pitch, grading bar, and build plan.

## Status

All six build steps are in place: synthetic data, data model, shared memory
schema, baseline + memory-informed agents, the baseline-vs-memory
comparison, and a dashboard to visualize it.

## Setup

```bash
npm install
cp .env.example .env   # then add your ANTHROPIC_API_KEY
```

## Pipeline

Run these in order — each depends on the previous step's output.

```bash
npm run generate:data     # synthetic batch -> data/generated/
npm run load:data         # load it into SQLite -> data/db/
npm run agents:baseline   # no-memory agents decide on every event
npm run agents:memory     # memory-informed agents decide on every event
npm run analyze:compare   # baseline vs memory numbers -> data/results/comparison_report.json
```

`agents:baseline` and `agents:memory` call the real Claude API (defaults to
`claude-opus-5`) once per event, and the batch is 3,202 events. Use
`--scenario=` or `--customer=` to test on a slice first, e.g.
`npm run agents:memory -- --scenario=cross_domain_risk`. Prefer those over
`--limit=N`: the runner sorts by timestamp, so `--limit` takes the *oldest*
events, all of which have empty as-of profiles and can never fire a memory
signal.

### Generate the synthetic batch

Writes a deterministic (seeded) batch of 1,200 customers to `data/generated/`:
`customers.json`, `cart_abandonment_events.json`,
`subscription_failure_events.json`, `dispute_events.json`,
`scenario_labels.json` (ground-truth scenario tag per customer — not part of
the real data model, used to evaluate whether the memory layer actually
catches the planted patterns), and `summary.json`.

Re-running with the same seed reproduces the same batch, so baseline-vs-memory
comparison runs diff identical data.

#### Scenario distribution

| Scenario | Share | Purpose |
| --- | --- | --- |
| `normal` | 60% | One clean, resolved event — no cross-agent signal |
| `repeat_offender_cart` | 5% | Repeated abandoned carts — gaming/stopping-rule target |
| `repeat_offender_subscription` | 5% | Repeated billing-cycle failures across `paid_count` |
| `repeat_offender_dispute` | 5% | Repeat dispute filer |
| `cross_domain_risk` | 10% | A dispute (shared `order_id`) on a past order, then a later cart. Outcome is `lost`/`under_review`/`won` at equal weight — the first two should suppress the discount, `won` should not |
| `churn_signal` | 10% | 2+ domains firing in a tight window — should escalate to a human |
| `noise` | 5% | Edge cases (no events, zero-value cart, contradictory states, widely-spaced events) |

### Data model ([src/types/events.ts](src/types/events.ts), [src/db/schema.sql](src/db/schema.sql))

The three event tables are a read model over data Razorpay already exports.
Each has one natural primary key — `order_id`, `payment_id`, `dispute_id` —
matching its real report; downstream layers keep a generic `event_id`,
normalised once at the `TaggedEvent` boundary in
[src/agents/runner.ts](src/agents/runner.ts).

| Table | Key columns |
| --- | --- |
| `cart_abandonment_events` | mirrors the ORDERS report: `amount`/`amount_paid`/`amount_due`, `attempts`, `last_method`, `last_error_code`, `last_error_description`, `notes` (JSON) |
| `subscription_failure_events` | a failed charge, keyed by `payment_id`; `subscription_id` repeats across cycles. `paid_count`/`total_count`, `method`, `error_code`, `error_description` |
| `dispute_events` | `dispute_created_at` (filed) and `resolved_at` (outcome known) as separate as-of dimensions |

`attempts = 0` means the customer never reached payment (intent drop-off);
`>= 1` means the payment was attempted and failed (friction drop-off).

### Shared memory ([src/memory/profile.ts](src/memory/profile.ts))

`dispute_count`, `recovery_frequency`, and `rolling_health_score` are
computed on read from the raw event tables (never materialized, so there's
no separate copy to drift out of sync), scoped to an `asOf` cutoff — a
decision only ever sees events at or before its own timestamp, never a
customer's future occurrences. `discount_usage_history` and `audit_log` are
scoped to `mode` (`baseline` vs `memory`) so the two comparison runs stay
independent hypotheticals over the same batch rather than one contaminated
timeline. Every memory read and every agent decision is appended to
`audit_log` with a reasoning string, an `entry_type`, the `MemorySignals`
snapshot it was made against, and — when the deterministic backstop
intervened — a `policy_override` record of what the model originally wanted.

Disputes are read **by outcome, as of the decision**, not by raw count:
`dispute_breakdown` splits them into `unresolved` / `won` / `adverse` /
`closed_undetermined`, where a dispute counts as resolved only once its
`resolved_at` is in the past. A customer who filed a dispute and won it is
evidence about the merchant's delivery, not about the customer, so it drives
no caution and no health penalty. `disputeCautionLevel` (`none` /
`unresolved` / `adverse`) sets the discount cap at 20% / 15% / 10%.

### Agents ([src/agents/](src/agents/))

Three agents (Cart Abandonment, Subscription Recovery, Dispute Responder),
each with a baseline variant (sees only the single triggering event) and a
memory variant (reads the shared profile plus precomputed policy signals —
stopping rule, gaming detection, composite churn escalation — that Claude is
instructed to treat as hard constraints, backed by a deterministic override
in code as a safety net). `npm run agents:baseline` / `agents:memory` run
the full batch and log every decision.

### Comparison ([src/analysis/compareRuns.ts](src/analysis/compareRuns.ts))

Joins the two decision logs by event, rolls up discount spend and
escalations per scenario, and checks the `cross_domain_risk` scenario
specifically on the exact "later cart" event that follows a dispute on the
same order.

That check is split into two cohorts with **opposite** expectations, because
the event shape is identical in both and only the dispute's outcome differs:

| Cohort | Planted outcome | Correct behaviour | Reported as |
| --- | --- | --- | --- |
| `adverse` | `lost` / `under_review` | suppress the discount | correct suppressions |
| `won` | `won` | do **not** suppress | false positives |

The report carries both cohorts with per-customer detail rows, plus a
precision-style summary (what share of all suppressions landed on the cohort
that deserved them). Reporting a single combined number would be
unfalsifiable — a system that reacted to *having* a dispute would score the
same as one that reads how it resolved.

### Dashboard ([src/server/](src/server/), [frontend/](frontend/))

A thin read-only Express API over the batch data and SQLite, plus a
React + Vite + Recharts frontend: an overview of the comparison numbers, and
a customer explorer with an event-by-event baseline-vs-memory table
(click a row for both agents' reasoning side by side) and a chart of memory
accumulating over a customer's timeline.

```bash
npm run server:dev          # API on :4000
cd frontend && npm run dev  # dashboard on :5173 (proxies /api to :4000)
```

## Checks

```bash
npm run typecheck
```

```bash
npm run verify:schema
```

`verify:schema` asserts the data-model invariants against the loaded DB: that
`resolved_at` is null exactly for unresolved disputes and strictly after
`dispute_created_at` otherwise, that every `cross_domain_risk` terminal
dispute resolves before that customer's later cart event, that
`disputeCautionLevel` at that later cart matches the planted outcome
(`won`→`none`, `lost`→`adverse`, `under_review`→`unresolved`), that the won
cohort is large enough to be non-anecdotal, and that `attempts`/`last_*` are
coherent. It makes no API calls.
