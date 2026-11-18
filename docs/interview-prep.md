# Interview prep

Every number here comes from `docs/agentic-vs-memory-results.md`, which is measured
on a synthetic dataset with a local Qwen 7B model. Outcomes are modelled, cost is
notional, and most per-scenario cells hold five events. Those qualifiers apply to
every figure below.

---

## 60-second pitch

Payment platforms run several recovery agents: one for abandoned carts, one for
failed subscription charges, one for disputes. Each sees its own slice of a
customer, so they can work against each other. A cart agent can offer a discount
to someone who is mid-dispute, and a retry can nudge someone who is already
working the system.

I built a shared memory layer for those agents. Each decision reads one customer
profile, as of the event's own timestamp, with policy signals computed from it.
A deterministic guardrail then decides what the agent may spend. On 40 cart events
I compared three arms: a baseline with no memory, a memory arm that receives the
profile and signals up front, and an agentic arm that fetches the same information
through three read-only tools in a LangGraph.js loop.

The result was not the one I expected. Memory cut discount spend by 47.4% against
the baseline, and the agentic loop by 83.5%, but both gave up conversion: 27.5 and
29.0 points of modelled conversion. Under the default outcome model the baseline
earned the most net. The agentic loop converted about the same as memory, at 4.2
times the tokens per decision. The honest conclusion is that under these modelled
outcomes, the discount lift is worth more than the spend it costs, and a
sensitivity check puts the break-even at about a tenth of the assumed lift.

---

## Why shared memory?

Because the decisions that matter span products. A cart agent that cannot see a
dispute can spend margin on a customer the business should not reward. A
subscription agent that cannot see recent recovery attempts cannot tell a real
payment problem from a customer working the system.

The layer is small on purpose: one as-of profile read, one set of policy signals,
and one guardrail. Every memory-informed arm reads the same profile, so differences
come from the decision, not from different information.

What the comparison shows about memory: the memory arm discounted 15 of 40 events,
against the baseline's 40 of 40, and its discounts were chosen with the customer's
history in view. It spent 47.4% less in total. It also converted less, 42.5%
against 70.0%, so under the default outcome model it earned less net. Memory is
not a free win. It is a trade between spend and conversion, and the result depends
on how much a discount lifts conversion.

Caveat to raise first: in the comparison database the memory arm had no discount
history of its own, because the compare command did not record its discounts. That
is fixed in the code, and the comparison has not been re-run.

---

## Why an agent loop, when memory can be prefetched?

I expected a loop might do better, because it can choose what to look at. The
measured answer is no, not on this data.

| | memory (prefetched) | agentic (loop, 3 tools) |
|---|---|---|
| conversion (modelled) | 42.5% | 41.0% |
| net (modelled, paise) | 4,665,500 | 4,327,500 |
| tokens per decision | 1,908 | 8,091 |
| model calls per decision | 1.0 | 3.8 |
| median summed latency per decision | 9.9 s | 12.8 s |
| notional cost per decision (USD) | 0.001793 | 0.006512 |
| discounted | 15 of 40 | 5 of 40 |

The loop used 2.77 investigation calls per decision on average. Every call read
information the memory arm already had in its prompt. So the loop paid for turns
that did not change the decision. Agentic is 4.2 times the tokens, 3.8 times the
calls, 3.6 times the notional cost, and 1.3 times the median latency, for a
conversion 1.5 points lower.

Where a loop could still help, and what this run cannot show: cases where the right
information depends on what you look at first, or where the agent can decide that
a question is not worth asking. On 40 events with a 7B model, the agent used two or
three investigation calls each time and never reached the four-call limit. I did
not measure which tools it chose.

**The gaming-pattern example (directional).** In the `cross_agent_gaming` cell, five
events per arm, memory kept the baseline's 60% conversion with 61% less average
spend (14,200 against 36,600 paise). The agentic arm converted 40% with no
discounts. That is the kind of result memory is for, but five events is not
evidence.

**The reminder default.** The agentic prompt now says a discount is a limit, not a
target, and a reminder is the default when the case is unclear. Agentic recommended
a reminder in 34 of 40 decisions. Its reminders converted 36.4%, against memory's
reminders at 37.5%, so the default did not visibly hurt recovery on reminders. It
may have cost recovery where a discount would have worked, but when agentic did
discount it converted 4 of 5, and the sample is too small to say.

---

## Sensitivity: does the answer depend on the outcome model?

Yes, and the sensitivity analysis shows how much. It holds every decision fixed and
rescales only the discount lift, the difference between paying with and without a
discount. Under the published lift (k = 1), the baseline has the highest net. Memory
and agentic match the baseline's net only when the lift is about 0.099 of the
assumed value. Above that, the baseline is ahead on net at every grid point up to
three times the assumed lift.

So the claim is not "discounting always pays". It is "under the modelled outcomes,
the lift is large enough that discounting more pays, and the answer flips only if
the lift is a tenth of what was assumed". The data cannot tell us the real lift.
The sensitivity result is a range of assumptions, not a finding about customers.

Be precise about what break-even means. Net is a step function: each event pays or
does not, and flips at one threshold. The break-even is where one event's outcome
changes, not a smooth balance point.

---

## Real-world use

- **Where it fits:** a decision layer in front of recovery actions, shared across
  products that touch the same customer. Read one as-of profile, compute policy
  signals, let a bounded agent propose an action, and let a deterministic guardrail
  have the final say.
- **What would have to change first:** the outcomes. The conversion and net here
  come from a probability table I wrote. A real deployment would learn them from
  payment events and hold out a randomised control, which this project does not do.
- **What I would not claim:** that this improves recovery in production. The
  measured result in this project is a trade-off that depends on an assumption the
  project cannot check.

---

## Limitations

- **Synthetic data.** The batch is generated, and patterns like "repeat offender"
  and "cross-agent gaming" are planted on purpose.
- **Modelled outcomes.** Whether a customer converts depends on a probability table
  I wrote, the same for every arm. The comparison shows what the policy does under
  those assumptions, not what customers do. The sensitivity analysis shows the
  answer depends on them.
- **Notional cost.** Local calls cost $0. The cost shown is what the same tokens
  would cost at a published rate.
- **Small samples.** Forty events, five per scenario cell. Most per-scenario
  differences are one or two events. I report them as directional.
- **A 7B local model.** A stronger model may behave differently. One agentic
  decision failed validation twice, and an earlier output cap truncated reasoning
  in smoke runs.
- **One agentic specialist.** Only cart abandonment has the loop. The subscription
  and dispute agents are single calls.
- **The memory arm's history.** The memory arm had no discount history in the
  comparison database. The comparison has not been re-run since the fix.
- **The earlier net was wrong.** It subtracted discounts on unpaid events and
  omitted dispute and recurrence costs. The corrected figures are in the results
  document. Any figure from before that correction should not be quoted.

---

## Future scope

In rough order of value:

1. Re-run the comparison with the memory arm recording its own discounts, on a
   larger sample, and report intervals rather than point estimates.
2. Replace the modelled outcomes with a randomised holdout, which measures what a
   discount causes rather than what a table assumes.
3. Try a larger local model, or a hosted one, to see whether the loop's cost buys
   anything at higher capability.
4. Extend the loop to the subscription and dispute agents, if the cart result
   justifies it. The plan would need to be written first.
5. Add an independent check on the guardrail's decisions, so a bug in policy code is
   caught before it reaches a customer.
