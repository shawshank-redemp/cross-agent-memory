# cross-agent-memory

Razorpay AI Buildathon submission — Track 03: AI Revenue Recovery.

A shared customer memory layer sitting above point-agents (Cart Abandonment,
Subscription Recovery, Dispute Responder) so each agent's decisions are
informed by what the others already know about a customer. See
[CLAUDE.md](./CLAUDE.md) for the full pitch, grading bar, and build plan.

## Status

Steps 1-3 of the build (synthetic data, data model, shared memory schema)
are in place. Agent decision logic and the dashboard come next.

## Setup

```bash
npm install
```

## Generate the synthetic batch

```bash
npm run generate:data
```

Writes a deterministic (seeded) batch of 250 customers to
`data/generated/`:

- `customers.json`
- `cart_abandonment_events.json`
- `subscription_failure_events.json`
- `dispute_events.json`
- `scenario_labels.json` — ground-truth scenario tag per customer (not part
  of the real data model; used to evaluate whether the memory layer actually
  catches the planted cross-agent patterns)
- `summary.json` — event/scenario counts for the batch

Re-running with the same seed reproduces the same batch, so baseline-vs-memory
comparison runs diff identical data.

### Scenario distribution

| Scenario | Share | Purpose |
| --- | --- | --- |
| `normal` | 60% | One clean, resolved event — no cross-agent signal |
| `repeat_offender_cart` | 5% | Repeated abandoned carts — gaming/stopping-rule target |
| `repeat_offender_subscription` | 5% | Repeated billing-cycle failures across `cycle_number` |
| `repeat_offender_dispute` | 5% | Repeat dispute filer |
| `cross_domain_risk` | 10% | A dispute (shared `order_id`) should suppress a later cart discount |
| `churn_signal` | 10% | 2+ domains firing in a tight window — should escalate to a human |
| `noise` | 5% | Edge cases (no events, zero-value cart, contradictory states, widely-spaced events) |

## Load the batch into SQLite

```bash
npm run load:data
```

Loads the JSON in `data/generated/` into `data/db/cross_agent_memory.sqlite`
(better-sqlite3, gitignored — schema lives in
[src/db/schema.sql](src/db/schema.sql)). Re-running clears and reloads, so
it's always in sync with the last `generate:data` run.

The shared memory profile ([src/memory/profile.ts](src/memory/profile.ts))
is computed on read from the raw event and `discount_usage` tables rather
than stored as a materialized row — `dispute_count`, `recovery_frequency`,
and `rolling_health_score` are always derived fresh, so there's no separate
copy that can drift out of sync. Every read (and, once agent logic lands,
every decision) is appended to `audit_log` with a reasoning string.

## Type check

```bash
npm run typecheck
```
