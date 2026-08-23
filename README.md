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
`claude-opus-5`) once per event — 481 events takes roughly 50-60 minutes and
makes real API calls. Use `--limit=N` to test on a slice first, e.g.
`npm run agents:memory -- --limit=20`.

### Generate the synthetic batch

Writes a deterministic (seeded) batch of 250 customers to `data/generated/`:
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
| `repeat_offender_subscription` | 5% | Repeated billing-cycle failures across `cycle_number` |
| `repeat_offender_dispute` | 5% | Repeat dispute filer |
| `cross_domain_risk` | 10% | A dispute (shared `order_id`) should suppress a later cart discount |
| `churn_signal` | 10% | 2+ domains firing in a tight window — should escalate to a human |
| `noise` | 5% | Edge cases (no events, zero-value cart, contradictory states, widely-spaced events) |

### Shared memory ([src/memory/profile.ts](src/memory/profile.ts))

`dispute_count`, `recovery_frequency`, and `rolling_health_score` are
computed on read from the raw event tables (never materialized, so there's
no separate copy to drift out of sync), scoped to an `asOf` cutoff — a
decision only ever sees events at or before its own timestamp, never a
customer's future occurrences. `discount_usage_history` and `audit_log` are
scoped to `mode` (`baseline` vs `memory`) so the two comparison runs stay
independent hypotheticals over the same batch rather than one contaminated
timeline. Every memory read and every agent decision is appended to
`audit_log` with a reasoning string.

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
specifically: does the memory-informed agent suppress the discount on the
exact "later cart" event that follows a dispute on the same order?

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

## Type check

```bash
npm run typecheck
```
