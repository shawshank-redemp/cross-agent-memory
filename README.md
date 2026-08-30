# cross-agent-memory

**Razorpay AI Buildathon — Track 03: AI Revenue Recovery**

A shared customer memory layer that sits above recovery point-agents, so each
agent's decision is informed by what the other agents already know about that
customer.

---

## The problem

Agent Studio's point-agents — Cart Abandonment, Subscription Recovery, Dispute
Responder — each operate inside their own boundary. None can see the others'
history of the same customer. That costs money in both directions:

- **Margin goes to customers who shouldn't get it.** A customer charges back an
  order, abandons a cart a month later, and the Cart Abandonment agent sees a
  routine abandonment and discounts it.
- **Real churn gets three bot nudges instead of one human.** A failed
  subscription charge, an abandoned cart and a dispute in one fortnight is one
  customer leaving — but three agents see three unrelated events.
- **Working the system is invisible.** Someone triggering a recovery discount
  every billing cycle looks fine to any agent looking at any single cycle.

Each agent reasons correctly over the data it has. The data is the problem.

## What this does

One profile per customer, assembled across domains, read by every agent before
it decides — plus a deterministic policy layer that can override the model when
the profile says the spend isn't warranted.

The `cross_domain_risk` case, which the batch plants and the pipeline verifies:

> A customer pays for an order. Two weeks later they dispute it. A month after
> that, they abandon a new cart.
>
> **Baseline** sees one abandoned cart and sends a discount.
>
> **Memory** sees the dispute on that customer's earlier order and reads *how it
> resolved*. Merchant contested it successfully (Razorpay `won`), or still
> unresolved → cap or suppress. Merchant conceded and refunded the customer
> (`lost`) → **don't** suppress; that outcome says nothing against them.

That last clause is what makes the claim testable. A system reacting to the mere
*existence* of a dispute would score identically to one reading the outcome, so
all three outcomes are planted at equal weight and scored as separate cohorts
with opposite expectations.

---

## Building blocks

| # | Piece | What it is |
| --- | --- | --- |
| 1 | **Synthetic batch** | 1,200 customers with deliberately planted cross-domain patterns |
| 2 | **Data model** | A read model over reports Razorpay already exports |
| 3 | **Shared memory** | Per-customer profile, computed on read, scoped as-of the decision |
| 4 | **Signal registry** | What the profile *means* and what it permits |
| 5 | **Agents + guardrail** | Claude proposes; deterministic policy disposes |
| 6 | **Comparison** | Baseline vs memory over identical data |

### 1. Synthetic batch ([src/data/](src/data/))

Seeded and deterministic, so both arms diff identical data. Customers are
assigned to scenarios that plant the patterns the memory layer should catch.

| Scenario | Share | What it tests |
| --- | --- | --- |
| `normal` | 24% | No cross-agent signal — the control |
| `repeat_offender_cart` | 18% | Gaming detection + discount stopping rule |
| `cross_domain_risk` | 14% | Dispute outcome suppressing a later discount |
| `churn_signal` | 9% | 2+ domains in a tight window → escalate to a human |
| `loyal_payer` | 8% | An established payer who abandons once — the accelerator, with no brake active |
| `conflicted_customer` | 7% | Heavy abandoner who also pays — brake and accelerator true at once |
| `cross_agent_gaming` | 6% | Recovery triggers spread across all three agents, none reaching its own threshold |
| `repeat_offender_subscription` | 4.5% | Repeat billing failure across cycles |
| `repeat_offender_dispute` | 4.5% | Repeat dispute filer |
| `noise` | 5% | Edge cases the pipeline must survive |

`scenario_labels.json` records the planted pattern per customer. It is ground
truth for scoring — no agent reads it.

### 2. Data model ([src/types/events.ts](src/types/events.ts), [src/db/schema.sql](src/db/schema.sql))

Three event tables mirroring reports Razorpay already produces — entity-typed
ids (`pay_`, `order_`, `dispute_`), amounts in paise, real status enums, each
table keyed by its own natural id.

| Table | Mirrors |
| --- | --- |
| `cart_abandonment_events` | the ORDERS report — amounts, `attempts`, last payment method and error |
| `subscription_failure_events` | a failed charge keyed by `payment_id`; `subscription_id` repeats across cycles |
| `dispute_events` | settlements-recon fields, with `dispute_created_at` and `resolved_at` as **separate** as-of dimensions |

A dispute annotates a payment/order rather than standing alone — which is the
point: disputes were never siloed at the data layer, only at the decisioning
layer.

### 3. Shared memory ([src/memory/profile.ts](src/memory/profile.ts))

Computed **on read** from the raw tables — never materialised, so there is no
second copy to drift — and every query scoped to an `asOf` cutoff, so a decision
sees only events at or before its own timestamp.

- **Disputes are read by outcome, as of the decision.** One counts as resolved
  only once `resolved_at` is past. A filed-but-unresolved dispute reads as
  unresolved *regardless of how it eventually went*, so a future ruling cannot
  leak backwards.
- **Razorpay dispute statuses are merchant-side.** `won` means the *merchant*
  contested successfully — the customer-adverse outcome. `lost` means the
  merchant conceded and the customer was refunded. Reading these the intuitive
  way inverts the whole policy, so a fixture test pins the mapping.

Every read and decision lands in `audit_log` with its reasoning, the signal
snapshot it was made against, and the policy version that governed it.

### 4. Signal registry ([src/agents/signals/](src/agents/signals/))

The profile answers *what is true about this customer*; the registry answers
*what that means*. Each signal is one object declaring how it is computed, how
it is explained to the model, and what it does to the decision.

- **Brakes** restrict — dispute caution, stopping rule, gaming, cross-agent
  gaming, composite churn.
- **One accelerator** widens: `provenPayer` lifts the cap for a customer with
  repeated successful payments across domains.
- **One router** changes *which* intervention fits: `paymentFriction` separates
  "never tried to pay" from "tried and was declined" — a discount doesn't fix a
  declined card.

**Brakes beat accelerators**: the resolved cap is the *minimum* across active
signals, so a proven payer who is also gaming gets the tighter cap and no
registry ordering can invert that.

Signals are customer-scoped or agent-scoped. Customer-scoped ones are true about
the *person*, so a fourth agent inherits them and implements only the rest.

### 5. Agents and the guardrail ([src/agents/](src/agents/))

Three agents in two variants: **baseline** sees only the triggering event,
**memory** also reads the profile and its signals. Both receive a word-for-word
identical objective — a weaker one for the baseline would make any measured
difference the objective's doing rather than memory's.

`enforcePolicy` is the only thing between a model output and money leaving:

- **Both arms** get spend bounds, action/spend coherence and a default ceiling.
  The baseline is a control, not an ungoverned system.
- **The memory arm** also gets caps, blocks and forced escalations resolved from
  its active signals.
- Overrides record what the model *wanted* and which signals overrode it, so
  "model and rules agreed" is a query, not a claim.
- If signals can't be evaluated it **fails closed** — no spend, escalate, and
  count it in the run summary.

Signal text is declarative, never imperative. If the prompt commanded the
outcome, model-rule agreement would be a tautology.

### 6. Comparison ([src/analysis/compareRuns.ts](src/analysis/compareRuns.ts))

Joins both decision logs event by event and reports spend and escalations per
scenario; **modelled revenue** (money collected, discount redeemed, dispute and
escalation cost, net lift) scored against a hidden outcome table the agents
never see; and **cross-domain suppression precision** — the `cross_domain_risk`
cohort split by planted outcome, correct suppressions against false positives.
A single combined number would be unfalsifiable.

---

## Running it

```bash
npm install
cp .env.example .env   # add ANTHROPIC_API_KEY
```

```bash
npm run generate:data     # synthetic batch  -> data/generated/
npm run load:data         # load into SQLite -> data/db/
npm run agents:baseline   # no-memory arm decides on every event
npm run agents:memory     # memory-informed arm decides on every event
npm run analyze:compare   # -> data/results/comparison_report.json
```

The agent steps call the Claude API once per event across 4,242 events. To try a
slice, `--scenario=` and `--customer=` select whole customers:

```bash
npm run agents:memory -- --scenario=cross_domain_risk
```

Prefer those over `--limit=N`: the runner sorts by timestamp, so `--limit` takes
the *oldest* events, which have empty as-of profiles and can never fire a signal.

**Dashboard** — read-only Express API plus a React + Recharts frontend: the
comparison numbers, and a customer explorer with an event-by-event
baseline-vs-memory table (click a row for both agents' reasoning side by side)
and memory accumulating across a customer's timeline.

```bash
npm run server:dev          # API on :4000
cd frontend && npm run dev  # dashboard on :5173
```

**Checks** — `npm run typecheck` (types + unit tests), `npm run validate:data`
(batch hygiene, plus that each scenario still reaches the signal it was written
for), `npm run verify:schema` (data-model and as-of invariants against the
loaded DB), `npm run verify:prompts` (both arms carry an identical, arm-neutral
objective). None call the API.

---

## Scope and limits

**Three agents:** Cart Abandonment, Subscription Recovery, Dispute Responder.

**Outcomes are modelled, not observed** — a hand-authored probability table the
agents never read. This demonstrates the mechanism; it is not a finding about
real customer behaviour. Claims are directional; cell counts at this size don't
support significance and nothing here claims it.

**Designed, not built:** a randomised incrementality layer
([src/experiment/config.ts](src/experiment/config.ts) holds the per-agent
config). Because the agent picks who gets a discount, the discounted group is
the one it judged most recoverable, so their conversion rate is uninterpretable;
randomising would separate correlation from incrementality. The config declares
Dispute Responder non-experimentable by design — every dispute needs some
handling, so there is no valid control.

**Also not built:** escalation budgets, absolute spend caps, per-customer rate
limits, an aggregate circuit breaker. Production needs all four; their absence is
a recorded choice, not an oversight.

Full design record and the reasoning behind each decision: [CLAUDE.md](./CLAUDE.md).
