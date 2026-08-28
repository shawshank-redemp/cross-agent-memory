# cross-agent-memory

Razorpay AI Buildathon submission — Track 03: AI Revenue Recovery.

## The idea

Razorpay's Agent Studio ships point-agents (Cart Abandonment, Subscription Recovery, Dispute Responder, RTO Shield, etc.) that each operate within their own boundaries and don't appear to share underlying customer state. We're building a **shared customer memory layer** that sits above point-agents so each one's decisions are informed by what the others already know about a customer.

Core mechanisms this unlocks :
1. **Better decisions**: dispute history should make the Cart Abandonment agent more cautious about spending a discount.
2. **Gaming detection**: recovery-frequency across cycles reveals a customer exploiting Subscription Recovery's discount nudge — invisible to any single agent looking at one cycle.
3. **Agents not working against each other**: RTO Shield's return-risk score should suppress Cart Abandonment's discount spend on a high-return-risk customer *before* the discount is spent, not after.
4. **Composite churn signal**: one failed subscription + one abandoned cart + WhatsApp silence, together, in the same window = escalate to human, not three redundant bot nudges.
5. **Individual-level fraud lens**: repeated "recovery" triggers across agents forming a working-the-system pattern.
6. **Compounding data moat**: every agent's decisions get better as the shared profile deepens.


## Scope: 3 agents

Cart Abandonment, Subscription Recovery, Dispute Responder.

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



## Experimentation layer (recovery incrementality)

### Why this exists

The memory layer today lets an agent make a better-informed choice. It does not
tell us whether the chosen intervention actually *caused* a better outcome.

The problem is self-selection. Claude picks who gets a discount, so the
discounted population is the one Claude judged most recoverable. If that group
converts at 70%, the number is uninterpretable: it looks identical whether the
discount moved everyone or nobody, because those customers may have converted
anyway. This matters most for cart abandonment specifically — abandoners are the
most self-selected audience in commerce, and published lift studies find a large
share of them convert without any intervention.

Randomisation breaks the link. A coin does not know who is recoverable, so the
treated and untreated groups contain the same mix of easy and hard cases, and any
outcome difference is attributable to the intervention alone. That converts a
correlation ("discounted customers return") into incrementality ("the discount
caused X extra returns at Y cost").

### Design decisions already made — do not relitigate these

- **Two-phase, not continuous.** Phase 1 runs the experiment and records
  outcomes; nothing learns during it. Phase 2 re-runs with the aggregated
  evidence available to agents. Continuous/online learning re-opens the asOf
  temporal-leakage problem for aggregated evidence and demos poorly. It is
  described in the writeup as the natural next step, not built.
- **Cart Abandonment only is enabled.** Subscription Recovery is experimentable
  in principle but deferred. Dispute Responder is deliberately excluded and must
  be marked non-experimentable: it has no valid control (every dispute must get
  some handling), and randomising between conceding and contesting means
  conceding disputes believed fraudulent in order to gather data. This exclusion
  is a feature of the design, not a gap.
- **Per-intervention eligibility, not per-customer.** The gate returns the list
  of interventions a customer may be randomised into, not a yes/no. A
  gaming-flagged customer stays in the study but with `send_discount` removed
  from their allowed list — so we learn about the exploiter population without
  spending margin on a suspected exploiter.
- **Fixed discount percentage in the discount arm.** No per-customer sizing by
  Claude inside a treatment arm — that would make the arm a heterogeneous mixture
  of Claude-chosen amounts and smuggle Claude's judgment back into the thing
  being isolated. Personalised sizing is a valid *future* treatment to test
  against uniform sizing; it is not how this arm is built.
- **The witness call is kept.** For enrolled customers Claude is still called and
  its free choice recorded, then discarded in favour of the coin's assignment.
  This disagreement record ("agent wanted to spend, coin said don't, customer
  converted anyway") is the primary demo artifact and the clearest expression of
  wasted margin.
- **Assignment is deterministic.** Hash of customer_id + experiment_id, never
  Math.random(), so re-runs reproduce identical assignments and the demo is
  stable.
- **Everything is asOf-scoped.** Eligibility and bucketing are computed from the
  memory profile as of the triggering event's timestamp, exactly like the profile
  itself. Enrolling or bucketing on an event that has not yet happened is the
  same bug class already fixed once in profile.ts.
- **Claims are directional, not statistical.** With this dataset size, cell
  counts are small. Language everywhere (code comments, API, UI) says
  "directionally consistent", never "statistically significant".
- **Honest framing on the outcome model.** Outcomes come from a hand-authored
  probability table in src/outcomes/probabilities.ts. The experiment layer must
  never read that table. It is a hidden ground truth; the layer observes only
  intervention → outcome. This is presented as a mechanism demonstration, not as
  discovery of an unknown real-world truth.

### Architectural requirement: agent-agnostic by construction

The experiment engine must contain no domain vocabulary — no "discount", no
"cart", no "reminder". It operates on opaque intervention IDs. Everything
domain-specific lives in per-agent config that the agent owns:

- its intervention IDs, and which one is the control
- which interventions are blocked under which memory signals
- which memory signal defines its moderator bucket
- which outcome fields it cares about

Adding a fourth agent later must be a config addition, not an engine change. An
agent must also be able to declare itself non-experimentable. Outcome fields are
agent-declared: do not hardcode a `recovered` boolean into the evidence schema,
since a different agent would care about different outcomes.

### Moderator bucket

One dimension, two buckets, split on prior discount history as of the event:
customers with one or more prior discounts vs. customers with none. Chosen
because it asks the sharpest business question — does discounting still work on
someone already discounted repeatedly — and derives directly from
`discount_usage_history`, which is already asOf-correct.

### Flow

Event fires → build memory profile (asOf) → eligibility gate returns allowed
interventions → if fewer than 2 allowed, not enrolled and the existing
memory-informed path runs unchanged → if 2 or more, enrolled: Claude's own choice
is logged then discarded, the coin assigns one allowed intervention, control
short-circuits to outcome with nothing sent, treatments execute and pass through
enforcePolicy() → outcome recorded.

enforcePolicy() remains the final authority on every path. The experiment
proposes; policy disposes. Policy must never be the mechanism that removes a
customer from an arm — ineligible customers are filtered before randomisation,
never vetoed after, since post-hoc vetoing would make the arms non-comparable.

## Model selection: Sonnet corrupts free-text fields under constrained decoding

Measured, not assumed. `claude-sonnet-5` drifts into Python-dict style
mid-response and tries to close a JSON string with `'`. Structured outputs uses
constrained decoding, so the grammar refuses `'` as a delimiter — and the
character is emitted as **literal text inside the still-open string** instead.
The model then closes the string properly with `"`, so the JSON is always
structurally valid and the SDK parses it faithfully. This is not a parser bug
and not a schema bug; the damage is confined to string *contents*.

Observed artifacts, all inside `reasoning`: a trailing `'`, a trailing `'}`, a
duplicated tail phrase (`...to recover the sale.the sale.'`), and in the worst
case an entire absorbed key-value pair
(`...abandonment.','discount_amount 38000 reflects 20% cap.'}`) — the model
attempting to close the string, add a key, and close the object, every
character of it swallowed as text.

Rates on the identical prompt and schema:

- `claude-sonnet-5`: ~25% of reasoning strings (10/40 in a real batch run; 1/12
  in an isolated probe).
- `claude-opus-5`: 0/12 in the same probe.

**Only free text is affected.** `action`, `discount_amount`, and
`escalate_to_human` are structurally constrained and come through clean, so a
Sonnet run's *decisions* are trustworthy even when its prose is not.

Conclusion, and the reason `claudeClient.ts` defaults to Opus rather than
picking the cheap model for you: **demo-quality runs and the final batch use
`claude-opus-5`. Sonnet via `CLAUDE_MODEL=claude-sonnet-5` is for
code-correctness iteration** — verifying that pipelines execute, signals fire,
and rows land — where reasoning prose is not the artifact being judged.
`reasoning` is both the audit-log field and what the dashboard displays, so
corrupted prose is a demo defect even though it is not a correctness one.

### Targeted runs, and why `--limit` is not enough

The runner sorts all events by timestamp, so `--limit=N` takes the N *oldest*
events in the batch. Under asOf scoping those all have empty memory profiles —
a `--limit` run exercises the plumbing but can never fire a memory signal.
`--scenario=` and `--customer=` (comma-separated, composable) exist for that:
they select whole customers, so a small run can reach `repeat_offender_cart` or
`cross_domain_risk` behaviour directly.

Both filters are deliberately customer-granular. `recovery_frequency` and
dispute counts are read from the raw event tables asOf-scoped, so they are
correct regardless of which events a run processes — but
`discount_usage_history` only contains discounts *this run granted*, so cutting
a customer off partway would under-report `stoppingRuleHit`. Selecting whole
customers keeps that faithful; `--limit` does not, and should not be trusted
for stopping-rule counts.
