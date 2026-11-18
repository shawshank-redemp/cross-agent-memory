# Agentic vs memory vs baseline: results on 40 cart events

## Summary

- Under the default modelled outcomes, **the baseline wins on net**: 7,214,500 paise, against 4,665,500 for memory and 4,327,500 for agentic.
- Memory cut total discount spend by **47.4%** against baseline. Agentic cut it by **83.5%**.
- The spend cuts cost conversion: memory gives up **27.5 points** (70.0% to 42.5%) and agentic gives up **29.0 points** (70.0% to 41.0%).
- Agentic does not beat memory. It converts 1.5 points less, at about **4.2 times the tokens** and **3.6 times the notional cost** per decision.
- The whole result rests on **modelled** outcomes, a **synthetic** dataset and a **local Qwen 7B** model. Most per-scenario cells hold **five events** and are directional only.

## What was run, and what the numbers are

- **Data:** a synthetic customer batch (700 customers, generated, not real payments).
- **Events:** 40 cart abandonment events, chosen by stratified round-robin across the labelled scenarios that have cart events (eight scenarios, five events each).
- **Database:** `data/compare40/compare40.sqlite`, rebuilt from the committed batch by `npm run agents:compare40`. The figures here come from that rebuild, referred to as run 2 below.
- **Model:** local Ollama, `qwen2.5:7b`, for all three arms. Nothing was sent to the Anthropic API. No model call was made to produce this document.
- **Arms:**
  - **baseline:** one model call, no memory, the universal guardrail only.
  - **memory:** one model call, with the shared customer profile and policy signals in the prompt, plus the memory guardrail.
  - **agentic:** a LangGraph.js ReAct loop with three read-only tools (customer profile, signals, discount policy), at most four investigation calls, then a validated decision that goes through the same guardrails.

### Which figures are measured, modelled or notional

| Figure | Status |
|---|---|
| Decisions, actions, committed spend, escalations, fallbacks | **Measured**: the arm's decision rows in the database |
| Tokens, model calls per decision, latency | **Measured**: `llm_call_metrics` rows |
| Paid or not, collected amount | **Modelled**: the probability table in `src/outcomes/probabilities.ts`, applied with the same per-event dice for every arm. A mechanism demonstration, not observed customer behaviour. |
| Net | **Modelled**: the scorer's `net_revenue` (collected, minus discount redeemed, minus dispute cost, minus recurrence cost, minus escalation handling), with the same dice |
| Cost | **Notional**: local calls cost $0. The figure is what the same token counts would cost at the paid Standard rate for `gemini-3.8-flash`, in `src/llm/pricing.ts`. |
| The dataset | **Synthetic** |

### Sample size

Each scenario cell holds **five events**, and the overall figures hold 40. At this size one event moves a rate by 2.5 percentage points, and one event moves a scenario cell's conversion by 20 points. Treat the per-scenario figures as directional. Treat the overall differences as directional too: they are not statistically tested.

## Is run 2 the same as run 1?

The earlier reading of this database, taken before it was rebuilt, and the current run 2 agree on:

- decisions, action counts (baseline 40 discounts; memory 15 discounts, 24 reminders, 1 no-action; agentic 5 discounts, 34 reminders, 1 no-action), and the one human-review fallback;
- committed spend (total discount 999,000 / 526,000 / 165,000 paise);
- token counts and notional cost per decision;
- conversion and escalation rates.

They differ on two things, for stated reasons:

- **Wall-clock latency.** Median summed model latency per decision is 10,589 / 11,225 / 15,486 ms in the earlier reading and 8,305 / 9,922 / 12,764 ms in run 2 (baseline / memory / agentic). Latency is timing, so it varies between runs. The figures below use run 2.
- **Net.** The earlier net used a formula that was wrong (see "Corrections" below). The net here is the corrected figure.

So the decision-level results reproduce. The timing does not, and the net had to be recomputed.

## Overall

Reproduce with `CROSS_AGENT_MEMORY_DB_PATH=data/compare40/compare40.sqlite npm run analyze:arms`.

```
arm       | decisions | discounted | avg discount paise | total discount paise | escalation | human-review fallback | conversion | net paise
baseline  |        40 |     100.0% |              24975 |               999000 |       0.0% |                  0.0% |      70.0% | 7214500
memory    |        40 |      37.5% |              13150 |               526000 |       0.0% |                  0.0% |      42.5% | 4665500
agentic   |        40 |      12.5% |               4125 |               165000 |       2.5% |                  2.5% |      41.0% | 4327500
```

Net per decision: baseline 180,363 paise, memory 116,638 paise, agentic 108,188 paise.

## Spend vs conversion

Measured spend against the baseline, with the conversion each arm gives up.

| arm | total discount (paise) | spend cut vs baseline | conversion | points lost vs baseline | net (paise) | net vs baseline |
|---|---|---|---|---|---|---|
| baseline | 999,000 | - | 70.0% | - | 7,214,500 | - |
| memory | 526,000 | 47.4% | 42.5% | 27.5 | 4,665,500 | -2,549,000 (-35.3%) |
| agentic | 165,000 | 83.5% | 41.0% | 29.0 | 4,327,500 | -2,887,000 (-40.0%) |

Spend cut is measured. Points lost and net are modelled.

**The plain statement:** under the default modelled outcomes, the baseline wins on net. It spends the most, and it converts the most, and under these outcomes the conversion is worth more than the spend. Both memory and agentic spend less and convert less, so both lose net against the baseline. This holds only under the default outcome model; see the sensitivity section, which asks how large the discount lift would have to be for the arms to change order.

## Cost of each decision

Reproduce with `CROSS_AGENT_MEMORY_DB_PATH=data/compare40/compare40.sqlite npx tsx scripts/perDecisionSummary.ts`.

| arm | tokens per decision (input + output) | model calls per decision | median summed latency per decision | notional cost per decision (USD) |
|---|---|---|---|---|
| baseline | 1,088 | 1.00 | 8,305 ms | 0.001164 |
| memory | 1,908 | 1.00 | 9,922 ms | 0.001793 |
| agentic | 8,091 | 3.80 | 12,764 ms | 0.006512 |

Agentic against memory: 4.2 times the tokens, 3.8 times the model calls, 3.6 times the notional cost, and 1.3 times the median latency. Agentic investigation calls averaged 2.77 per decision: nine decisions used two and thirty-one used three.

The `analyze:metrics` table for the same run:

```
cart_abandonment | agentic  | qwen2.5:7b | 152 | 317729/5913 | 2129.2 | 0/0 | notional $0.001714 | 2139/9427 | 10.3 | 2.77 (40 decisions)
cart_abandonment | baseline | qwen2.5:7b |  40 |  38889/4640 | 1088.2 | 0/0 | notional $0.001164 | 8305/10838 | 14.5 | 0.00 (40 decisions)
cart_abandonment | memory   | qwen2.5:7b |  40 |  71474/4827 | 1907.5 | 0/0 | notional $0.001793 | 9922/13195 | 12.5 | 0.00 (40 decisions)
```

Its cost column is per request. Per-decision cost differs from it by the number of calls per decision.

## What each arm decided

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

## Per scenario (five events per cell, directional)

"Avg discount" is average committed spend over all five events, zeros included.

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

The two other labelled scenarios, `repeat_offender_subscription` and `repeat_offender_dispute`, have no cart events and cannot appear in a cart comparison.

**Gaming-scenario example (directional).** In `cross_agent_gaming` the memory arm matched the baseline's conversion, 60%, with 61% less average spend (14,200 against 36,600 paise). The agentic arm converted 40% with no discounts. This is five events per arm.

## Sensitivity analysis (not evidence)

`npm run analyze:sensitivity` holds every stored decision fixed and rescales only the discount lift in each scenario (the difference between paying with and without a discount), by a factor k. The grid was fixed in advance: k from 0 to 3, with k = 1 the published assumption. Nothing was tuned to favour an arm. `probabilities.ts` is unchanged.

| k | baseline conv | baseline net | memory conv | memory net | agentic conv | agentic net |
|---|---|---|---|---|---|---|
| 0 | 37.5% | 3,951,000 | 37.5% | 4,161,500 | 35.9% | 3,990,000 |
| 0.25 | 47.5% | 4,962,000 | 37.5% | 4,161,500 | 38.5% | 4,282,500 |
| 0.5 | 52.5% | 5,569,000 | 40.0% | 4,350,500 | 38.5% | 4,282,500 |
| 0.75 | 62.5% | 6,361,000 | 40.0% | 4,350,500 | 41.0% | 4,327,500 |
| 1 (published) | 70.0% | 7,214,500 | 42.5% | 4,665,500 | 41.0% | 4,327,500 |
| 1.5 | 87.5% | 9,691,500 | 55.0% | 6,567,500 | 41.0% | 4,327,500 |
| 2 | 90.0% | 9,891,500 | 57.5% | 6,756,500 | 43.6% | 4,527,500 |
| 3 | 100.0% | 10,450,000 | 60.0% | 6,999,500 | 43.6% | 4,527,500 |

**Break-even.** Memory and agentic match the baseline's net at about **k = 0.099**, roughly a tenth of the published lift. Above that, the baseline's net is higher than both arms' at every grid point. Below it, the arms do better, because a discount that does not lift conversion is pure spend.

**Why the break-even is a step, not a smooth crossing.** Each event either pays or does not, and it flips at one threshold. Baseline's net jumps from 3,951,000 to 4,320,000 paise at about k = 0.099, when one event flips to paid. Both arms cross the baseline at that one point. The break-even is therefore where one event's outcome changes, not a balance point.

**What this does and does not show.** It shows that under these decisions, the baseline's advantage holds unless the discount lift is much smaller than assumed. It does not show that the assumed lift is realistic, and holding the decisions fixed is itself an assumption. Agents that were told a discount does less would decide differently.

## Verdict

**Does agentic beat memory on decision quality?** No, not on this data. It converts 1.5 points less (41.0% against 42.5%), and its net is 7.2% lower (4,327,500 against 4,665,500). At 40 events a difference of one or two conversions is within noise, so the two are indistinguishable on conversion. Agentic is not ahead on net.

**At what cost?** Agentic uses 4.2 times the tokens of memory per decision (8,091 against 1,908), 3.8 times the model calls, 3.6 times the notional cost (USD 0.006512 against 0.001793), and 1.3 times the median summed latency.

**Did the reminder default hurt recovery?** Not on reminders. Agentic's reminders converted 36.4% (33 events), and memory's reminders converted 37.5% (24 events). Agentic's discounts converted 4 of 5 (80%), and memory's converted 8 of 15 (53%). Both comparisons rest on very few events. The default may have cost recovery on cases where a discount would have worked, but this sample cannot tell.

**The bigger point.** Under the default outcome model, the extra conversion from discounting more than covers the extra spend, so memory and agentic lose net by spending less. The comparison of spend cut against points lost, in the table above, shows the trade. Whether that holds depends on the discount lift, and the sensitivity analysis shows the baseline's advantage only reverses if the lift is about a tenth of the assumed size. The data cannot tell us the real lift.

**Limits that matter for these conclusions:** the outcomes are modelled, the cost is notional, the dataset is synthetic, the cells hold five events, the local model is a 7B, and the memory arm had no discount history in this database (see below).

## Corrections

- **Net in the earlier version of this document was wrong.** It subtracted the committed discount even for events the customer did not pay, where the scorer redeems a discount only on payment. It also left out dispute and recurrence costs. Under the earlier formula, baseline net was 6,971,000, memory 4,514,000 and agentic 4,325,000. Those were incorrect. The corrected figures are 7,214,500, 4,665,500 and 4,327,500.
- The conversion, spend, token, and decision figures in the earlier version were correct and are unchanged.

## Caveats about this database

1. **The memory arm had no discount history of its own.** When these decisions were made, the compare command did not record baseline or memory discounts, so the memory arm's signals could not see its earlier discounts. That is fixed in commit `9c53ded`. This database predates the fix and has not been re-run, because re-running needs model calls. The memory arm's figures may understate what memory does with its own history.
2. **The database is dated after the revised agentic prompt** (commit `f58fc3a`), so it reflects that prompt.

## How to reproduce

```
CROSS_AGENT_MEMORY_DB_PATH=data/compare40/compare40.sqlite npm run analyze:arms
CROSS_AGENT_MEMORY_DB_PATH=data/compare40/compare40.sqlite npm run analyze:metrics
CROSS_AGENT_MEMORY_DB_PATH=data/compare40/compare40.sqlite npx tsx scripts/perDecisionSummary.ts
CROSS_AGENT_MEMORY_DB_PATH=data/compare40/compare40.sqlite npm run analyze:sensitivity
```

No command here makes a model call.
