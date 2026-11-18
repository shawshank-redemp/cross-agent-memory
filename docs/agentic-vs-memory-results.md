# Agentic vs memory vs baseline: results on 40 cart events

## What was run, and what the numbers are

- **Data:** a synthetic customer batch (700 customers, generated, not real payments).
- **Events:** 40 cart abandonment events, chosen by stratified round-robin across the labelled scenarios that have cart events (eight scenarios, five events each). Database: `data/compare40/compare40.sqlite`, produced by `npm run agents:compare40`.
- **Model:** local Ollama, `qwen2.5:7b`, for all three arms. Nothing was sent to the Anthropic API.
- **Arms:**
  - **baseline:** one model call, no memory, the universal guardrail only.
  - **memory:** one model call, with the shared customer profile and policy signals, plus the memory guardrail.
  - **agentic:** a LangGraph.js ReAct loop with three read-only tools (customer profile, signals, discount policy), at most four investigation calls, then a validated decision that goes through the same guardrails.

### Which numbers are measured, which are modelled, which are notional

| Figure | Status |
|---|---|
| Tokens, model calls, latency, decisions, actions, escalations, fallbacks, committed spend | **Measured** from the run's database rows |
| Conversion and collected amount | **Modelled.** Outcomes come from the hand-written probability table in `src/outcomes/probabilities.ts`, applied with the same per-event dice for every arm. They are a mechanism demonstration, not observed customer behaviour. |
| Net | **Modelled.** Collected minus committed spend minus escalation handling, using the scoring constant. |
| Cost | **Notional.** Local Ollama calls cost $0. The figure is what the same token counts would cost at the paid Standard rate for `gemini-3.8-flash`, from `src/llm/pricing.ts`. |
| The dataset | **Synthetic.** |

### Sample size

Each scenario cell holds **five events**. The overall figures hold 40. At this size one event moves a rate by 2.5 percentage points, and a single event changes a scenario cell's conversion by 20 points. Treat every difference here as directional, not statistically significant.

### Two caveats about this database

1. **The memory arm in this database had no discount history.** When these decisions were made, the compare command did not write baseline or memory discount rows, so the memory arm's signals could not see its own earlier discounts. That is fixed in commit `9c53ded`. This database predates the fix and was not re-run, because re-running needs model calls. The memory arm's numbers below may therefore understate what memory does with its own history.
2. **The database is dated after the revised agentic prompt** (commit `f58fc3a`), so it reflects that prompt. I did not re-verify that by re-running.

## Overall

Reproduce with `CROSS_AGENT_MEMORY_DB_PATH=data/compare40/compare40.sqlite npm run analyze:arms`.

```
arm       | decisions | discounted | avg discount paise | total discount paise | escalation | human-review fallback | conversion | net paise
baseline  |        40 |     100.0% |              24975 |               999000 |       0.0% |                  0.0% |      70.0% | 6971000
memory    |        40 |      37.5% |              13150 |               526000 |       0.0% |                  0.0% |      42.5% | 4514000
agentic   |        40 |      12.5% |               4125 |               165000 |       2.5% |                  2.5% |      41.0% | 4325000
```

Net per decision: baseline 174,275 paise, memory 112,850 paise, agentic 108,125 paise.

## Cost of each decision

Reproduce with `CROSS_AGENT_MEMORY_DB_PATH=data/compare40/compare40.sqlite npx tsx scripts/perDecisionSummary.ts`.

| arm | tokens per decision (input + output) | model calls per decision | median summed latency per decision | notional cost per decision (USD) |
|---|---|---|---|---|
| baseline | 1,088 | 1.00 | 10,589 ms | 0.001164 |
| memory | 1,908 | 1.00 | 11,225 ms | 0.001793 |
| agentic | 8,091 | 3.80 | 15,486 ms | 0.006512 |

Agentic investigation calls averaged 2.77 per decision (nine decisions used two, thirty-one used three). Tool calls per decision are also reported by `npm run analyze:metrics`.

The `analyze:metrics` table for the same run, for reference:

```
cart_abandonment | agentic  | qwen2.5:7b | 152 | 317729/5913 | 2129.2 | 0/0 | notional $0.001714 | 2697/10422 | 8.9 | 2.77 (40 decisions)
cart_abandonment | baseline | qwen2.5:7b |  40 |  38889/4640 | 1088.2 | 0/0 | notional $0.001164 | 10589/13064 | 12.9 | n/a
cart_abandonment | memory   | qwen2.5:7b |  40 |  71474/4827 | 1907.5 | 0/0 | notional $0.001793 | 11225/17082 | 11.4 | n/a
```

Its per-call cost column reads per request, so per-decision cost differs from it by the calls per decision.

## What each arm decided

Actions, from the arms' final decisions:

| arm | send_discount | send_reminder | no_action |
|---|---|---|---|
| baseline | 40 | 0 | 0 |
| memory | 15 | 24 | 1 |
| agentic | 5 | 34 | 1 |

The agentic figure of 34 reminders includes the one human-review fallback, which recorded a reminder with escalation set. Outcomes are recorded only for decided events, so 33 agentic reminders have outcomes.

## Conversion by action (modelled outcomes)

| arm | action | n | conversion | average collected (paise) |
|---|---|---|---|---|
| baseline | send_discount | 40 | 70.0% | 199,250 |
| memory | send_discount | 15 | 53.3% | 163,333 |
| memory | send_reminder | 24 | 37.5% | 107,917 |
| agentic | send_discount | 5 | 80.0% | 196,000 |
| agentic | send_reminder | 33 | 36.4% | 106,364 |

The single `no_action` decision in each of memory and agentic is left out of this table. It was not a send, and its outcome row records no conversion.

## Per scenario (five events per cell)

Reproduce with the three-arm report. "avg discount" is average committed spend over all five events, zeros included.

| scenario | arm | n | avg discount (paise) | escalation | conversion |
|---|---|---|---|---|---|
| churn_signal | baseline | 5 | 17,300 | 0.0% | 60.0% |
| churn_signal | memory | 5 | 9,000 | 0.0% | 20.0% |
| churn_signal | agentic | 5 | 0 | 20.0% | 0.0% |
| conflicted_customer | baseline | 5 | 31,300 | 0.0% | 80.0% |
| conflicted_customer | memory | 5 | 8,400 | 0.0% | 20.0% |
| conflicted_customer | agentic | 5 | 0 | 0.0% | 20.0% |
| cross_agent_gaming | baseline | 5 | 36,600 | 0.0% | 60.0% |
| cross_agent_gaming | memory | 5 | 14,200 | 0.0% | 60.0% |
| cross_agent_gaming | agentic | 5 | 0 | 0.0% | 40.0% |
| cross_domain_risk | baseline | 5 | 13,800 | 0.0% | 60.0% |
| cross_domain_risk | memory | 5 | 7,600 | 0.0% | 20.0% |
| cross_domain_risk | agentic | 5 | 1,000 | 0.0% | 40.0% |
| loyal_payer | baseline | 5 | 21,900 | 0.0% | 80.0% |
| loyal_payer | memory | 5 | 8,000 | 0.0% | 60.0% |
| loyal_payer | agentic | 5 | 31,000 | 0.0% | 80.0% |
| noise | baseline | 5 | 27,500 | 0.0% | 60.0% |
| noise | memory | 5 | 12,800 | 0.0% | 20.0% |
| noise | agentic | 5 | 0 | 0.0% | 20.0% |
| normal | baseline | 5 | 29,000 | 0.0% | 80.0% |
| normal | memory | 5 | 20,600 | 0.0% | 60.0% |
| normal | agentic | 5 | 0 | 0.0% | 60.0% |
| repeat_offender_cart | baseline | 5 | 22,400 | 0.0% | 80.0% |
| repeat_offender_cart | memory | 5 | 24,600 | 0.0% | 80.0% |
| repeat_offender_cart | agentic | 5 | 1,000 | 0.0% | 60.0% |

The other two labelled scenarios, `repeat_offender_subscription` and `repeat_offender_dispute`, have no cart events and cannot appear in a cart comparison.

## Verdict

**Does agentic beat memory on decision quality?** No, not in this run. Agentic is slightly lower on both measures: conversion 41.0% against 42.5%, and net 4.33 million paise against 4.51 million. At 40 events the conversion gap is well under one event's worth, so I would call the two arms indistinguishable on quality here, with agentic not ahead.

**At what cost?** Agentic uses about 4.2 times the tokens of memory per decision (8,091 against 1,908), about 3.6 times the notional cost (USD 0.006512 against 0.001793), and about 1.4 times the median summed latency (15.5 s against 11.2 s), with 3.8 model calls per decision against 1.0.

**Did the reminder default hurt recovery?** The data does not show that it did relative to memory. Agentic's reminders converted 36.4% (33 events) against memory's reminders at 37.5% (24 events). The default did cost something elsewhere: when agentic did discount, it converted 4 of 5 (80%), and memory's discounts converted 8 of 15 (53%). Those are small samples. The baseline arm, which discounted every event, converted 70% at an average of 24,975 paise per decision. Whether a discount-first policy is worth its spend depends on the outcome model, which is modelled, not measured.

**Limits that matter for these conclusions:** the outcomes are modelled, the cost is notional, the dataset is synthetic, the cells hold five events, the local model is a 7B, and the memory arm had no discount history in this database (see the caveats above). The honest reading is: in this setup, the agentic loop costs several times as much and does not improve the measured outcome over memory alone.

## How to reproduce

```
CROSS_AGENT_MEMORY_DB_PATH=data/compare40/compare40.sqlite npm run analyze:arms
CROSS_AGENT_MEMORY_DB_PATH=data/compare40/compare40.sqlite npm run analyze:metrics
CROSS_AGENT_MEMORY_DB_PATH=data/compare40/compare40.sqlite npx tsx scripts/perDecisionSummary.ts
```

No command here makes a model call.
