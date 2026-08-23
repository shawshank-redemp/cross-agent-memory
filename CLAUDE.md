# cross-agent-memory

Razorpay AI Buildathon submission — Track 03: AI Revenue Recovery.
Deadline: submit by Sept 1-2, 2026 (hard close Sept 5). Deliverables: public GitHub repo, 5-minute pitch video, architecture writeup.

## The idea

Razorpay's Agent Studio ships point-agents (Cart Abandonment, Subscription Recovery, Dispute Responder, RTO Shield, etc.) that each operate within their own boundaries and don't appear to share underlying customer state. We're building a **shared customer memory layer** that sits above point-agents so each one's decisions are informed by what the others already know about a customer.

Core mechanisms this unlocks (this is the actual pitch — lead with these, not "avoid bombarding the customer"):
1. **Better decisions**: dispute history should make the Cart Abandonment agent more cautious about spending a discount.
2. **Gaming detection**: recovery-frequency across cycles reveals a customer exploiting Subscription Recovery's discount nudge — invisible to any single agent looking at one cycle.
3. **Agents not working against each other**: RTO Shield's return-risk score should suppress Cart Abandonment's discount spend on a high-return-risk customer *before* the discount is spent, not after.
4. **Composite churn signal**: one failed subscription + one abandoned cart + WhatsApp silence, together, in the same window = escalate to human, not three redundant bot nudges.
5. **Individual-level fraud lens**: repeated "recovery" triggers across agents forming a working-the-system pattern.
6. **Compounding data moat**: every agent's decisions get better as the shared profile deepens.

## Buildathon bar we're graded against (Track 03)

Not just detection — **measured money recovered across a batch**, with:
- **Compliant escalation** — defined handoff-to-human rules (e.g. composite churn signal above)
- **Stopping rules** — bounded limits per customer (e.g. max discount attempts before an agent must stop and escalate; this is also literally the gaming-detection payoff)
- **Audit trail** — every agent decision must log what it read from memory, what it decided, and why. Not optional — this is graded.

## Scope: 3 agents, not 4

Cart Abandonment, Subscription Recovery, Dispute Responder. (RTO Shield is a stretch goal only if time allows — richer 3-agent interaction beats shallow 4-agent interaction.)

## Tech stack

- **Language**: TypeScript end-to-end (backend, frontend, agent logic) — the builder knows JS/TS/React, not Python.
- **Backend**: Node.js + Express, REST API for ingesting synthetic events and serving the memory layer.
- **DB**: SQLite (better-sqlite3 or Prisma) — zero external setup, file-based, easy to inspect. Must include an audit-log table (every memory read/write gets a logged reason string, not just a value — retrofit later is painful, build it in from day one).
- **Agent decision logic**: TS modules, one per agent, calling the **Claude API via @anthropic-ai/sdk** for the actual reasoning step (not hardcoded if/else) — mirrors how Razorpay's own Agent Studio is built.
- **Dashboard**: React + Vite + Recharts — visualize memory profile accumulation over time and the baseline-vs-memory decision divergence.
- **Optional (Day 8-9 stretch)**: Razorpay test-mode Node SDK + webhooks as a thin real-checkout credibility layer feeding the same pipeline as synthetic data. Not load-bearing for the core deliverable.

## Six-piece build (the actual dependency order)

1. Synthetic customer base, 200-300 customers, single shared `customer_id` every event type keys off of.
2. Three point-agents — build the **no-memory baseline version first** (isolated decisions), this becomes the comparison control.
3. Shared memory schema — the actual core artifact. Per-customer profile: dispute count, discount-usage history, recovery-frequency, rolling health/engagement score. Includes audit log. Design this before agent logic that depends on it.
4. Decision logic wired to read/write memory — dispute history → discount caution, recovery frequency → gaming detection + stopping rule, return risk → spend suppression. This is the hardest and most important part.
5. Baseline-vs-memory comparison run over the same synthetic batch — this is what makes "shared memory helps" a measured claim, not an assertion. Produces the actual numbers for the pitch.
6. Thin event loop + dashboard to make the mechanism visible.

## Data model (grounded in real Razorpay sample reports)

Pulled from Razorpay's actual sample report exports (payments, subscriptions, refunds, orders, settlements-recon). Match these conventions for realism — a judge who's seen these reports will recognize them:

- **ID prefixes are entity-typed**: `pay_...`, `order_...`, `rfnd_...`, `sub_...`, `plan_...`, `setl_...`.
- **Amounts are in the smallest currency unit** (paise, not rupees).
- **Status enums are specific**: payments use `captured`/`refunded`/`failed`; orders use `created`/`attempted`/`paid`; refunds carry `refund_status` of `full`/`partial`.
- **Disputes are an annotation on a payment/order**, not a standalone entity — `dispute_id`, `dispute_created_at`, `dispute_reason` live alongside the underlying `payment_id`/`order_id` (this is real Razorpay structure and it fits our shared-memory pitch: disputes were never siloed at the data layer, only at the decisioning layer).
- **Subscriptions carry `paid_count`/`total_count`** — use this as the natural `cycle_number` for tracking repeat subscription failures.

### Customer
```
customer_id, name, email, contact, signup_date, plan_tier
```

### CartAbandonmentEvent (models Order + Payment attempt)
```
event_id (order_...), customer_id, order_id, amount, currency, status (created/attempted),
cart_value, items, channel, timestamp
```

### SubscriptionFailureEvent (models Subscription)
```
event_id (sub_...), customer_id, subscription_id, plan_id, plan_amount,
cycle_number (maps to paid_count/total_count), failure_reason, status, timestamp
```

### DisputeEvent (models settlements-recon dispute fields, tied to a payment)
```
event_id (dispute_...), customer_id, payment_id, order_id, amount,
dispute_reason, dispute_created_at, status
```

### Shared memory profile (the core artifact)
```
dispute_count, total_disputed_amount, discount_usage_history,
recovery_frequency (per agent type, over time), rolling_health_score,
audit_log[]: { timestamp, agent, action, reasoning }
```

### Synthetic data generation — volume and pattern, not more event types

More event *types* is explicitly out of scope (stay at 3 — cart abandonment, subscription failure, dispute). What's needed instead is deliberately engineered patterns across the customer batch, because the cross-agent value (gaming detection, composite churn, dispute-informed discounting) only shows up when a customer has multiple, related events over time:

- ~60% "normal" customers — one clean event, resolves fine.
- ~15% "repeat offenders" per agent — multiple cycles of the same event (use `cycle_number` for subscription failures) to trigger gaming detection + stopping rules.
- ~10% "cross-domain risk" — a dispute (via shared `payment_id`/`order_id`) that should suppress a later cart-abandonment discount.
- ~10% "churn signal" — the composite pattern: 2+ domains firing in a tight time window, which should trigger escalation rather than more automated nudges.
- ~5% pure noise/edge cases.

## Working agreement

- Repo is public — nothing confidential goes in it (no internal Razorpay specifics, even if sourced informally).
- Builder (Sheshank) wants to review/give feedback as you go, not have the whole thing appear finished. Prefer incremental, reviewable commits over big-bang changes.
- When a design decision has real trade-offs (e.g. schema shape, escalation thresholds), surface the trade-off and ask rather than silently picking one.
