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

The event tables are a **read model that mirrors data Razorpay already has**.
Every column should correspond to something in Razorpay's real reports —
invented fields weaken the deployability argument. A field earns its place if
a signal reads it, an agent's decision depends on it, or it's a real Razorpay
column kept for fidelity, in that priority order.

- **ID prefixes are entity-typed**: `pay_...`, `order_...`, `rfnd_...`, `sub_...`, `plan_...`, `setl_...`.
- **One identifier per row, and it is the natural one.** Each event table's primary key is the entity's own Razorpay id (`order_id`, `payment_id`, `dispute_id`), because a real export has exactly one `id` per row. Downstream layers (runner, audit log, trace, comparison) are deliberately agent-agnostic and keep a generic `event_id`; the two vocabularies meet exactly once, at the `TaggedEvent` boundary in `runner.ts`.
- **Amounts are in the smallest currency unit** (paise, not rupees).
- **Status enums are specific**: payments use `captured`/`refunded`/`failed`; orders use `created`/`attempted`/`paid`; refunds carry `refund_status` of `full`/`partial`.
- **Disputes are an annotation on a payment/order**, not a standalone entity — `dispute_id`, `dispute_created_at`, `dispute_reason` live alongside the underlying `payment_id`/`order_id` (this is real Razorpay structure and it fits our shared-memory pitch: disputes were never siloed at the data layer, only at the decisioning layer).
- **Subscriptions carry `paid_count`/`total_count`** — `paid_count` is the cycle counter for tracking repeat subscription failures.
- **Trust event time, not processing time.** Anything with a "when did we learn this" dimension needs its own timestamp and must be filtered as-of. This system has already had two temporal-leakage bugs.

### Customer
```
customer_id, name, email, contact, signup_date, plan_tier
```

### CartAbandonmentEvent (mirrors a row of the ORDERS report)
```
order_id (PK, order_...), customer_id, amount, amount_paid, amount_due, currency,
status (created/attempted/paid), attempts, last_method, last_error_code,
last_error_description, notes (JSON), created_at
```

`attempts` is the field that matters: `0` means the customer never tried to
pay (intent drop-off), `>= 1` means they tried and the payment failed
(friction drop-off). No agent branches on it yet — it is the groundwork for
failure-reason branching. Coherence invariants the generator upholds:

| status | attempts | `last_method` | `last_error_*` |
| --- | --- | --- | --- |
| `created` | 0 | null | null |
| `attempted` | >= 1 | set | set |
| `paid` | >= 1 | set | null (the last attempt succeeded) |

`notes` is Razorpay's free-form key/value bag on an order — item count and
acquisition channel live there rather than as promoted columns, which is where
a real integration would put them. `last_method` / `last_error_code` /
`last_error_description` are **payments**-report fields denormalised onto the
order row, not orders-report columns: real data one join away, flattened into
a read model.

### SubscriptionFailureEvent (a failed subscription CHARGE = a failed payment)
```
payment_id (PK, pay_...), subscription_id (FK, repeats across cycles), customer_id,
plan_id, plan_amount, plan_period, plan_interval, paid_count, total_count,
status, method, error_code, error_description, created_at
```

`subscription_id` cannot be a primary key: one subscription legitimately fails
across many cycles. The row's identity is the charge attempt.
`error_code`/`error_description` are the real payments-report fields, replacing
the free-text `failure_reason`. `plan_period`/`plan_interval` are real Razorpay
plan columns carried for fidelity; every plan in this batch is monthly/1
because the generator spaces cycles ~20-30 days apart.

### DisputeEvent (models settlements-recon dispute fields, tied to a payment)
```
dispute_id (PK, dispute_...), customer_id, payment_id, order_id, amount,
dispute_reason, dispute_created_at, resolved_at, status
```

`resolved_at` is null for `open`/`under_review` and strictly after
`dispute_created_at` for `won`/`lost`/`closed`. It is not a literal Razorpay
column (their API exposes status transitions via webhooks); it exists because
the outcome of a dispute has a "when did we learn this" dimension. Without it,
reading `status` alone leaks a future ruling backwards into a past decision.
A resolution may fall beyond the batch's observation window — that is a dispute
this batch never sees resolve, and it correctly reads as unresolved throughout.

### Shared memory profile (the core artifact)
```
dispute_count, total_disputed_amount,
dispute_breakdown: { unresolved, merchant_conceded, customer_adverse, closed_undetermined },
adverse_disputed_amount, unresolved_dispute_reasons,
discount_usage_history, recovery_frequency (per agent type, over time),
recent_events (raw asOf-scoped {agent,timestamp}, 90-day bound),
successful_payment_count, total_paid_amount, rolling_health_score,
audit_log[]: { timestamp, agent, entry_type, action, reasoning }
```

### Audit log

Columns for what gets filtered or joined on, JSON for what is only displayed:
`timestamp, customer_id, agent, mode, entry_type ('memory_read'|'decision'),
event_id, action, reasoning, escalate_to_human, signals (JSON),
policy_override (JSON), metadata (JSON)`.

`signals` is the `MemorySignals` snapshot the decision was made against;
`policy_override` records what the model originally wanted and which signals
overrode it. Together they make "the LLM proposes, deterministic code
disposes" a query rather than a claim. `discount_usage` carries `event_id`
alongside the cart-only `order_id`, so a discount is traceable back to its
triggering event in all three domains.

### Synthetic data generation — volume and pattern, not more event types

More event *types* is explicitly out of scope (stay at 3 — cart abandonment, subscription failure, dispute). What's needed instead is deliberately engineered patterns across the customer batch, because the cross-agent value (gaming detection, composite churn, dispute-informed discounting) only shows up when a customer has multiple, related events over time:

- ~60% "normal" customers — one clean event, resolves fine.
- ~15% "repeat offenders" per agent — multiple cycles of the same event (use `paid_count` for subscription failures) to trigger gaming detection + stopping rules.
- ~10% "cross-domain risk" — a dispute (via shared `payment_id`/`order_id`) on a past order, followed by a later cart abandonment. The dispute's outcome is drawn at equal weight from `lost` / `under_review` / `won`, and it decides what correct behaviour is. Remember the status words are merchant-side: `won` (merchant contested successfully) and `under_review` should suppress the later discount, `lost` (merchant conceded, customer refunded) should NOT. The merchant-conceded arm is what makes the scenario falsifiable — without it, a system that reacted to the mere existence of a dispute would score identically to one that reads the outcome. Terminal disputes are forced to resolve strictly before the later cart so the cart agent sees a resolved outcome rather than an unresolved one. The planted outcome is recorded on the scenario label as `dispute_outcome`.
- ~10% "churn signal" — the composite pattern: 2+ domains firing in a tight time window, which should trigger escalation rather than more automated nudges.
- ~5% pure noise/edge cases.



## Razorpay dispute semantics — the status words are merchant-side

**A Razorpay dispute belongs to the MERCHANT, so its status describes how it
went for the merchant, not the customer.** This is the opposite of the
intuitive reading and the code shipped with it inverted once.

| Razorpay status | What actually happened | Profile bucket | Caution |
| --- | --- | --- | --- |
| `won` | The bank accepted the **merchant's** evidence; the complaint was rejected | `customer_adverse` | adverse |
| `lost` | The bank rejected the merchant's evidence and refunded the customer. Also the status when a merchant simply **accepts** a dispute rather than contesting | `merchant_conceded` | none |
| `closed` | Ended with no ruling either way (withdrawn) | `closed_undetermined` | none |
| `open` / `under_review` | No ruling yet | `unresolved` | reason-derived |

`DisputeBreakdown`'s field names deliberately do **not** reuse `won`/`lost`,
because reading `breakdown.won` as "the customer won" is exactly the mistake
that caused the inversion. The mapping is pinned by a fixture in
`scripts/pinDisputeMapping.ts`, which runs first in `npm run verify:schema`
and fails loudly if the arms are ever flipped back.

The as-of rules in `readDisputeStats` remain the correctness core:

- **Visible** if `dispute_created_at <= asOf`.
- **Resolved** only if `resolved_at IS NOT NULL AND resolved_at <= asOf`.
- A visible-but-unresolved dispute counts as `unresolved` **regardless of its
  stored `status`**. The eventual outcome has not happened yet and must not
  leak backwards.

`dispute_count` / `total_disputed_amount` still count every dispute filed as
of the read, any status: the dashboard reads them.
`computeRollingHealthScore` charges `customer_adverse * 12 + unresolved * 6`;
merchant-conceded and closed disputes are free.

### The unresolved tier is reason-aware

A dispute takes weeks to resolve, so at decision time **most disputes are
unresolved and the reason is the only evidence available**. `disputeCautionLevel`
therefore splits that tier by who the reason points at
(`DISPUTE_FAULT_BY_REASON` in `data/fixtures.ts` is the single source of truth):

| Level | Trigger | Discount cap |
| --- | --- | --- |
| `none` | nothing counts against them | 20% |
| `unresolved_merchant_fault` | goods not received, service not as described | 20% |
| `unresolved_neutral` | duplicate charge, subscription not cancelled | 15% |
| `unresolved_customer_fault` | unrecognized transaction | 10% |
| `adverse` | a `customer_adverse` dispute exists | 10% |

Most severe wins; within the unresolved tier the order is
customer > neutral > merchant. **An unmapped reason defaults to `neutral`,
never to `customer`** — an unrecognised string must not manufacture suspicion.

`unresolved_merchant_fault` gets *no penalty*, not a goodwill bonus: it sits at
the default cap and contributes no cap at all, so it cannot hold a proven payer
back from the wider ceiling. Treating a wronged customer as actively
higher-value is a separate product decision and a valid future extension.

## Composite churn is a recency lookback, not a window comparison

Composite churn fires when **two or more distinct domains have at least one
event in the `CHURN_LOOKBACK_DAYS` (14) immediately preceding and including the
triggering event**. The triggering event counts as one of them.

This replaced a rule that compared each agent's *aggregate* window (first event
to last event) and fired when two windows came within 14 days. That was wrong
twice over: a window can span months, so two events 36 days apart could satisfy
"within 14 days"; and nothing aged out, so a bad fortnight eight months ago
still tripped the signal today.

To support it, the profile exposes `recent_events` — raw asOf-scoped
`{agent, timestamp}` pairs, ascending, bounded to
`PROFILE_RECENT_EVENTS_LOOKBACK_DAYS` (90). That bound is **storage**, not
policy, and must stay >= every policy lookback that reads it; `thresholds.ts`
asserts this at module load.

**Separation of concerns:** `profile.ts` exposes facts (raw asOf-scoped
timestamps); the signal registry owns the rule (the 14-day threshold). The
threshold must never move into `profile.ts`.

### `recent_events` is a filtered population — settled, do not relitigate

`recent_events` contains **recovery-flow triggering events only**: non-paid
carts, `failed`/`halted` subscription cycles, and all disputes. These are the
same filters `recovery_frequency` already uses. It is deliberately **not** a
raw union of the three event tables.

The reason is what the churn signal is supposed to mean. A customer who paid
successfully and separately disputed something later is **not the same risk
shape** as a customer with two recovery-flow failures in the same fortnight.
Conflating them weakens the signal: composite churn would start firing on
customers whose only "activity" was a completed purchase, and the escalation it
triggers would stop being evidence of anything. Under a raw union it would fire
across much of `cross_domain_risk` — those customers have a *paid* order
followed by a dispute — turning a churn signal into a "had two events" signal.

A secondary benefit: holding the population fixed is what lets
`npm run measure:churn` attribute its before/after delta to the **window logic**
alone, rather than confounding the rule change with a population change.

This is a settled design decision, not a simplification to revisit.

Measured before/after on the committed batch: **identical, 238/3202 firings
under both rules**. Every multi-domain customer in this batch has at most one
event per domain, which collapses each window to a single point and makes the
two rules mathematically equivalent. The old rule is wrong in principle and the
synthetic data never exercises the failure mode — so this is a correctness fix
with no effect on the reported numbers. `npm run measure:churn` reproduces the
table and cross-checks the live rule.

## The signal registry

Signals live in `src/agents/signals/`. Each is one self-contained object
declaring `id`, `scope`, `kind`, `compute(ctx)`, `describe(value)` and
`effects(value)`. `policy.ts` is now a thin re-export facade.

**Adding a signal computed from facts the profile already exposes is a
single-file change inside `src/agents/signals/`.** No edit to the
`MemorySignals` interface, the prompt string, or `enforcePolicy` — because:

- `MemorySignals` is a **mapped type derived from the registry**, not
  hand-maintained. Two hand-written lists would drift. `keyof MemorySignals`
  still resolves to the signal ids, so the experiment layer's `blockRules` and
  `excludeEntirelyWhen` compile unchanged. A compile-time assertion pins that
  the derived type still covers all seven original fields with their original
  value types.
- The prompt's signal half is **generated** from `describe()`, so prompt text
  and enforcement cannot disagree.
- `enforcePolicy` **resolves `effects()`** rather than testing hardcoded
  booleans.

A signal needing NEW facts additionally requires a `profile.ts` change. That
split is deliberate: `profile.ts` answers *what is true about this customer*
and holds every asOf-scoped query so temporal correctness is auditable in one
place; the registry answers *what that means and what to do about it*.

This structure exists because adding a signal used to mean four disconnected
edits with nothing tying them together — which is how the churn-signal discount
gap (commit `75f04a3`) happened.

### Three kinds

- **brake** — restricts what the agent may do. `disputeCautionLevel`,
  `stoppingRuleHit`, `gamingSuspected`, `crossAgentGamingSuspected`,
  `compositeChurnSignal`.
- **accelerator** — widens what the agent may do for a customer who earned it.
  `provenPayer`: 2+ successful payments across all domains raises the cap to
  25%. Purely factual — it does not check for gaming or disputes; precedence
  settles conflicts.
- **router** — changes *which* intervention fits without changing limits.
  `paymentFriction`: the customer tried to pay and was declined, so the
  problem is mechanical and a discount does not address it.

`paymentFriction` is deliberately **prompt-only**, carrying no effects. There
is no "retry with another payment method" action in the decision schema, and
adding one would change the outcome model — a documented future step. It is
still recorded on the audit row so its influence on divergence is measurable.

### Scope is the pluggability contract

- **customer-scoped** (`disputeCautionWarranted`, `disputeCautionLevel`,
  `crossAgentGamingSuspected`, `compositeChurnSignal`, `provenPayer`): true
  about the *person*. A new agent inherits them unchanged.
- **agent-scoped** (`discountAttemptsForAgent`, `stoppingRuleHit`,
  `gamingSuspected`, `paymentFriction`): computed against the asking agent.

**Registering a fourth agent means implementing only the agent-scoped ones.**
`signalsByScope()` enumerates each set.

### Precedence: brakes beat accelerators

`resolveSignalEffects` takes the **minimum** cap across every active signal.
A proven payer who is also gaming gets 10%, not 25%, and no ordering of the
registry can invert that because minimum is commutative.
`DEFAULT_DISCOUNT_CAP_PERCENT` (20) is the fallback when nothing contributes,
**not** a participant in the minimum — folding it in would give `min(20, 25)`
and the accelerator could never do anything.

`enforcePolicy` now also **clamps** a discount to the resolved cap, recording
the clamp in `policy_override`. Caps were previously prompt-only advice.


## The decisioning layer

### The shared objective is an experimental invariant

`OBJECTIVE_BLOCK` in `src/agents/objective.ts` states the goal and the relative
cost of each lever. It is included **word-for-word identically** in both the
baseline and the memory-informed system prompts.

This is not tidiness, it is what keeps the baseline a valid control. The only
intended difference between the arms is whether the agent can see the
customer's shared history. If the baseline received a different objective —
even a slightly weaker or shorter one — any measured difference would be partly
the objective's doing and the comparison would no longer isolate memory. One
exported constant, used by both, is why a copy cannot drift.

The objective is also **arm-neutral**: it says nothing about memory, disputes,
gaming, churn, or customer history. Anything memory-specific belongs in the
memory policy block, which only one arm receives.

Costs are stated as a relative **ordering** (reminder/retry < escalation <
discount), never as rupee figures. `ESCALATION_HANDLING_COST_PAISE` and
`DISPUTE_HANDLING_FEE_PAISE` exist in the outcome model for **scoring** and are
deliberately not surfaced to the agent — an agent optimising against the same
table that grades it is marking its own homework. The agent gets the shape of
the trade-off; the scorer keeps the numbers.

`npm run verify:prompts` asserts all of this: both arms carry the objective
verbatim, the objective mentions none of the forbidden memory vocabulary, and
it contains no rupee figures.

### Dispute economics live in their own shared constant

`OBJECTIVE_BLOCK` prices discounts, reminders/retries and escalation — none of
which is what the Dispute Responder does. Its actions are `accept_dispute` and
`contest_dispute`, and conceding forfeits the disputed amount in full: the
single most expensive action any agent here can take. Its prompt described what
those actions *mean* and never what they *cost*, so the agent making the most
expensive decision was inferring its economics from nothing.

The fix is `DISPUTE_COST_MODEL` in `objective.ts`, **not** an addition to
`OBJECTIVE_BLOCK`. That block ships in all three agents' prompts and must stay
universal; pricing `accept_dispute` in the cart prompt would be noise competing
with the case data.

It is **one constant interpolated into both dispute prompts**, for exactly the
reason the objective is: the baseline and memory dispute prompts are separate
strings, so hand-writing it into each recreates the drift risk the shared
constant exists to prevent. It is arm-neutral by construction — it describes the
economics of two actions, which are equally true with or without memory — and
states costs as an ordering, never rupee figures. `verify:prompts` asserts both
dispute prompts carry it verbatim, that the other two agents do **not**, and
that it mentions no memory vocabulary.

### Reasoning first — verified, not assumed

Structured output emits fields in **schema declaration order**. With `reasoning`
declared last, the model committed to an action and then explained it: a
post-hoc justification. `reasoning` is now the first declared property, so those
tokens are the reasoning the decision actually follows from.

Confirmed against a real response rather than assumed — key order does not
survive `JSON.parse`, so `scripts/verifyFieldOrder.ts` inspects the **raw**
response text through the production `decideRaw()` path. Observed on
`claude-opus-5`: `reasoning` at char 1, `action` at char 465, in declaration
order.

No `.max()` on `reasoning`: under constrained decoding a hard cap either
truncates mid-string (mangled audit rows) or fails validation and triggers the
retry path, costing more than the tokens saved. `max_tokens` (2048) plus the
`stop_reason === "max_tokens"` throw remain the runaway guardrail.

### Signals are evidence, not commands

Every signal's `describe()` states a **fact and what policy permits given it**.
None issues an order. The transformation was from "You MUST NOT grant another
discount and MUST set escalate_to_human=true" to "Policy does not permit
spending margin on a customer in this state, and cases like this are handled by
a person rather than automation."

**Enforcement is completely unaffected** — no `effects()` changed, and
`enforcePolicy` applies every declared effect deterministically exactly as
before. Imperative prompt text bought no safety on top of that. What it did buy
was a measurement problem: if the prompt commands the outcome, then
`policy_override.original_action` records the model *obeying an instruction*
rather than exercising judgment, and "the model and the deterministic rules
agreed" becomes a tautology instead of a result. Declarative text is what makes
that agreement worth reporting.

### Escalation is a disposition, not an action

`action` is what should happen to the customer. `escalate_to_human` is whether a
person signs off before it happens. They are orthogonal, and
`"escalate_to_human"` is no longer a value in any action enum — it used to be
both, which let a decision hold contradictory values (`send_discount` with
`escalate_to_human: true`) and meant an escalated dispute reached a human as a
bare "escalated" with no recommendation attached. Now a reviewer inherits
"contest_dispute, pending human review".

Fallback actions when policy blocks spend: cart → `send_reminder`,
subscription → `retry_payment`, dispute → `contest_dispute` (which exists only
to typecheck: dispute decisions always commit null spend, so the block can never
fire there).

### Decision schema

Declaration order is load-bearing, so it is listed in order:

| Field | Notes |
| --- | --- |
| `reasoning` | 3-5 sentences, generated first |
| `memory_factors_used` | fixed enum, self-reported — see below |
| `action` | per-agent enum, escalation removed |
| `committed_spend_paise` | renamed from `discount_amount` |
| `escalate_to_human` | disposition, orthogonal to action |
| `escalation_reason` | nullable enum, required when escalating |

`committed_spend_paise` replaces `discount_amount` because every agent may
commit spend and dispute happens to commit none: under the old name, `null` on
a dispute read as "field does not apply", where now it means "this action
commits no spend", which is information. It also makes the schema
agent-agnostic. **DB column names are unchanged** (`discount_usage.amount`,
`audit_log.metadata.discount_amount`) — this is a decision-schema rename mapped
at the boundary, not a migration.

`escalation_reason` is coupled to `escalate_to_human` deterministically in
`enforcePolicy`, not by a zod `.refine()`: a refinement failure under
constrained decoding costs a whole retry call to fix a one-line coercion. When
policy *forces* an escalation the model did not ask for, the reason is set to
`"policy_constraint"` and `policy_override.escalation_reason_forced` records
that it was not the model's own.

#### `memory_factors_used` is self-reported attribution

It is **evidence about the model's stated reasoning, not ground truth about what
caused the decision**. It must never be described as proof that memory changed a
decision — that claim belongs to the baseline-vs-memory comparison, which
measures outcomes rather than asking the model to introspect.

**The citable set must equal the set of fields that can appear in the payload.**
A field sent but not citable makes attribution under-report — the model used it
and had no way to say so. A field citable but never sent is a phantom option
that can only ever be chosen in error, inflating the counts. Both corrupt the
attribution, in opposite directions.

So the enum is **derived**, not hand-maintained: `memoryPayloadKeys.ts` declares
the emittable `memory_profile` keys, `buildUserContent`'s payload object is
typed against them (emitting an unlisted key is a compile error), and
`schema.ts` builds the enum from the same constant plus every registry
`SignalId`. Every signal is citable because every signal can appear — an active
one in the generated prose, an inactive one in the `policy_signals` JSON.

"Can appear" is the test, not "always appears": `dispute_breakdown`,
`unresolved_dispute_reasons` and `adverse_disputed_amount` are sent only when no
dispute finding is stated in prose, and stay citable because the model will not
cite what it was not given.

Two guards, neither of which edits the model's answer:

- **Baseline must always be empty.** Baseline agents receive no history, so a
  non-empty value there means memory has leaked into the control arm. The runner
  logs each occurrence loudly and reports a `baselineMemoryLeaks` count.
- **Unsupported citations are counted.** A cited *signal* that was inactive is
  an unsupported claim. `unsupported_factor_citations` records these per
  decision. They are counted and reported, never overwritten — silently
  correcting the model's stated reasoning would destroy the artifact being
  measured. Profile-field citations are not audited this way: the field was
  sent, so citing it is never provably unsupported.

### Request payload is trimmed

- `recent_decisions` carries structured facts only (agent, action, committed
  spend, timestamp), never the reasoning prose. Cost was the smaller problem;
  the real one is anchoring — the model reads its own past arguments and tends
  to agree with them, so a customer's timeline compounds an early judgment
  instead of re-examining it.
- `policy_signals` sends only signals **not** already stated in the generated
  prose, plus numeric values regardless (magnitude is information prose carries
  badly).
- `recovery_frequency` windows are dropped from the payload — composite churn
  reads `recent_events` now and nothing else consumed them.
- `dispute_breakdown` / `unresolved_dispute_reasons` are dropped only when a
  dispute caution level is already stated in prose. Both are *judgment*-shaped —
  they are what the caution level is derived from, so once it is stated they add
  nothing.
- **Both amount fields are always sent.** The rule is: **prose carries
  judgments, JSON carries magnitudes.** A signal can say "a dispute was resolved
  against this customer"; no signal says whether it was for a trivial sum or a
  ruinous one, and those should lead to different decisions.

  `adverse_disputed_amount` was briefly conditional, which had it exactly
  backwards: it was sent only when the caution level was `"none"`, `"none"`
  requires `customer_adverse === 0`, and the field sums those same rows — so it
  was guaranteed to be `0` every time it was sent and withheld every time it was
  not. Measured on the committed batch: sent on 1,785 cart events, non-zero in
  **0** of them; withheld while non-zero on **58**. Always-sending it also makes
  the zero informative rather than noise — it states that nothing has been
  resolved against this customer.
- The user message ends with a task statement, not a closing brace. Data first,
  instruction last, and the instruction is shared across both arms for the same
  reason the objective is.

### No few-shot examples — settled, do not revisit

Any example worth writing would demonstrate memory changing a decision, which is
exactly what the baseline-vs-memory comparison exists to measure. Including one
would make demonstration indistinguishable from instruction-following, and it
could not go into both arms identically without handing the baseline the very
capability it is the control for. Self-reported confidence scores are also
excluded: LLM confidence is uncalibrated and would invite weighting decisions by
a number that means nothing.



## The guardrail layer

enforcePolicy is the only thing standing between a model output and money
leaving the business. It is split in two.

### Universal vs memory-derived policy — both arms share the universal layer

| Layer | Contents | Applies to |
| --- | --- | --- |
| **Universal** (`enforcement.ts`) | spend bounds, action/spend coherence, the default `DEFAULT_DISCOUNT_CAP_PERCENT` ceiling | **both arms** |
| **Memory-derived** (`enforcePolicy`) | tightened/widened caps, blocks, forced escalation from `resolveSignalEffects()` | memory arm only |

Before this split the baseline returned raw model output with no enforcement at
all. That was a safety gap, but the worse problem was that it was a
**confound**: any measured "memory saved money" partly reflected the mere
existence of a guardrail rather than anything memory contributed. The control
arm now gets the same standing business rules a real deployment would have.

**Expect the headline gap between arms to shrink.** That is the correct
outcome, not a regression — the remaining gap is what memory actually
contributes. Do not treat the smaller number as a bug.

The memory arm passes its resolved cap *into* the shared clamping logic rather
than clamping separately, so the ceiling is enforced in exactly one place.
A baseline `policy_override` row carries a NULL `signals` value, which is
coherent: baseline has no memory from which to compute them.

### Coherence runs before blocking

`AGENT_ACTION_POLICY` declares which actions may carry spend (cart and
subscription: `send_discount`; dispute: none) next to the action enums, not
inside the enforcement code.

Order matters, and specifically coherence must precede the block rule. The block
rule swaps the action to a non-spend fallback whenever it removes spend. If an
incoherent `no_action` + spend reached it with the spend intact, the guardrail
would swap the action to `send_reminder` — **adding an outbound message the
model never asked to send**. Nulling incoherent spend first makes that
unreachable, and a test pins it.

### Spend bounds

- **Negative spend** is a malformed output, not a decision. It would slip past
  the ceiling check (it is below it), reduce measured spend, and inflate net
  revenue. Rejected outright and logged loudly.
- **Zero spend** is never written. A zero-amount `discount_usage` row still
  increments `discountAttemptsForAgent`, pushing a customer toward a gaming flag
  on the strength of a discount that does not exist.
- The ceiling is guarded against a zero or missing amount. This is not
  theoretical: the `noise` scenario plants a zero-value cart, where
  `floor(0 * pct / 100)` is 0, so the guardrail itself would otherwise
  manufacture the bad row.

### Fail closed

If the profile read or `computeMemorySignals` throws, the guardrail cannot
evaluate — so it takes the conservative action rather than crashing or passing
model output through unguarded: no spend, `escalate_to_human` true,
`escalation_reason` `"policy_constraint"`, and an override naming the failure.
The model is not called at all when the failure happens before the request.

Counted and reported as `guardrailFailures` in the run summary, because a
**silent** fail-closed is worse than a crash: the run looks complete while some
number of cases were handed to a human without being reasoned about.

Distinct from the runner's per-event catch, which handles API failures. An API
failure means "no decision"; this means "a decision we do not trust ourselves to
make automatically".

### Run resilience

`decide()` retries once then throws, and workers are joined with `Promise.all` —
so one failure at event 3,000 used to reject every worker and discard a paid
run. Now: each event is individually caught, decisions are appended to a
`.partial.jsonl` sidecar as they are made, the run summary lists every failed
`event_id`, and the process exits non-zero so a partial run is never mistaken
for a complete one. `--resume` skips events that already have a `decision` row
in `audit_log` for that mode.

The concurrency model is unchanged and deliberately so: whole customers run in
parallel, never individual events.

### Idempotency

`discount_usage` is unique on `(event_id, mode)` and `audit_log` on
`(event_id, mode, entry_type)`, each paired with `ON CONFLICT DO UPDATE` so a
re-decide replaces rather than duplicates. The conflict clause is not optional:
a **bare** unique index would convert silent duplication into a hard mid-run
insert crash on the retry path that exists precisely to recover from crashes.
`event_id` is nullable and SQLite treats each NULL as distinct, so cross-cutting
rows carrying no event id are unaffected.

### asOf scoping no longer depends on runner ordering

`readDiscountUsageHistory` and `readAuditLog` filtered on `customer_id` and
`mode` only. They were correct, but only because `runner.ts` sorts tagged events
by timestamp and runs each customer's queue sequentially in one worker — the
guarantee lived in the runner, not the query. Remove that sort, parallelise at
event granularity, or add any out-of-order write path, and temporal leakage
returns silently. Same bug class as commit `c33eed8`, in the two fields that
escaped it. Both are now asOf-scoped; omitting `asOf` still returns everything,
which is the dashboard's whole-batch read.

This required fixing **mixed clocks** first: `memory_read` rows fell through to
wall-clock `new Date()` while decision rows used the event's timestamp, so one
column ordered by `timestamp` held both synthetic batch dates and real ones —
and an asOf filter would have compared a synthetic date against a real one and
matched nothing.

### Policy versioning

`audit_log` recorded the signals snapshot and the policy_override but not
*which policy* turned one into the other. Change `MIN_SUCCESSFUL_PAYMENTS` from
2 to 3, or `CHURN_LOOKBACK_DAYS` from 14 to 30, and every historical row
silently becomes uninterpretable — you can still see what the signals said, but
not what the system did with them. "Why was this customer denied a discount in
March" needs *March's* policy.

Every `decision` row now carries `policy_version` = `POLICY_FINGERPRINT`, which
has two halves:

- **`POLICY_VERSION`** — a manually bumped string (`2026-08-30.1`).
- **`POLICY_THRESHOLDS_HASH`** — sha256 (first 8 hex) of a canonical
  serialisation of every exported constant in `thresholds.ts` plus each signal's
  id, scope and kind. Keys are sorted at every depth so the hash cannot move on
  declaration order or formatting; a version that drifts on unrelated edits is
  worthless.

**The gap, stated rather than glossed over:** `effects()` are functions and are
not hashable. A change to a signal's effect logic that touches neither a
threshold value nor the signal id/scope/kind list will **not** move the hash.
That is exactly what the manual half covers, and why the fingerprint has two
parts — hash-only would silently miss effect changes, version-only relies
entirely on someone remembering.

Recorded on **both arms**: baseline is governed by `DEFAULT_DISCOUNT_CAP_PERCENT`
and `AGENT_ACTION_POLICY`, so it has a policy too, and one fingerprint covering
the whole policy surface is simpler to explain and to query than two partial ones
a reader would have to know how to combine. `memory_read` rows leave it NULL for
the same reason `escalate_to_human` is NULL there: a read decides nothing.

It is **metadata about the run, not evidence about the customer** — never in the
prompt payload, never a citable `memory_factors_used` value.
`npm run policy:version` prints the fingerprint and the resolved thresholds so
the writeup can cite the exact policy a run used.

### Adding a column is not a migration, but it is not free either

`CREATE TABLE IF NOT EXISTS` is a no-op on a table that already exists, so a db
file written before a column was added keeps the old shape forever — and
`load:data` does not help, because it DELETEs rows rather than recreating
tables. Without a check, the first affected INSERT throws "no such column" in
the middle of a batch run, after the API calls are paid for.

`openDb()` therefore parses the column list out of `schema.sql` and fails at
open with an actionable message (`rm -rf data/db && npm run load:data`). The
data is seed-regenerated and disposable, so deleting is the fix; the point is
that it is said at open rather than discovered at event 400.

### Known design limits — deliberate, not oversights

Real production deployments would need these. They are recorded rather than
built, so their absence is a documented choice:

- **No escalation budget.** Nothing caps how many cases can be escalated in a
  run, so a systematic signal misfire could route an unbounded number of
  customers to human review.
- **No absolute spend cap.** Ceilings are percentages of the event amount only,
  so a sufficiently large order permits a large discount.
- **No rate limits.** Nothing bounds spend per customer per unit time, or across
  the batch as a whole.
- **No aggregate spend budget and no circuit breaker.** Nothing halts a run that
  is spending anomalously, and no escalation gating exists beyond the per-signal
  rules.


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
