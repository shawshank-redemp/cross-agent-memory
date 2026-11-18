# Interview prep

Every number here comes from `docs/agentic-vs-memory-results.md`, which is
measured on a synthetic dataset with a local Qwen 7B model. Modelled and
notional figures are labelled as such.

---

## 60-second pitch

Payment platforms run several recovery agents: one for abandoned carts, one for
failed subscription charges, one for disputes. Each sees its own slice of a
customer, so they can work against each other. A cart agent can offer a discount
to a customer who is in the middle of a dispute, and a subscription retry can
nudge someone who is already gaming the system.

I built a shared memory layer for those agents. Every decision reads one
customer profile, as of the event's own timestamp, with policy signals computed
from it. A deterministic guardrail then decides what the agent may actually spend.
I compared three arms on 40 cart events: a baseline with no memory, a memory arm
that receives the profile and signals up front, and an agentic arm that gets the
same information through three read-only tools in a LangGraph.js loop.

The honest result: the agentic loop did not beat the prefetched memory arm. It
converted about the same share of customers (41.0% against 42.5%, which is less
than one event at this sample size), at about 4.2 times the tokens per decision.
The useful finding is that the memory layer and the guardrail carry most of the
value, and a loop adds cost unless it earns its keep on a larger sample.

---

## Why shared memory?

Because the decisions that matter are the ones that span products. A cart agent
that cannot see a dispute will spend margin on a customer the business should
not reward. A subscription agent that cannot see a customer's recent recovery
attempts cannot tell a genuine payment problem from a customer working the
system.

The layer is small on purpose. It is one as-of profile read, one set of
policy signals, and one guardrail. Every arm reads the same profile, so
differences between arms come from the decision, not from different information.
The memory arm in the comparison measured this: it discounted 15 of 40 events,
against the baseline's 40 of 40, and its discounts were chosen with the customer's
history in view.

Caveat I would raise first: in the comparison database the memory arm had no
discount history of its own, because the compare command did not record its
discounts. That is fixed, and the comparison has not been re-run.

---

## Why an agent loop, when memory can be prefetched?

I expected a loop might do better, because it can choose what to look at. The
measured answer is no, not on this data.

| | memory (prefetched) | agentic (loop, 3 tools) |
|---|---|---|
| conversion | 42.5% | 41.0% |
| net (modelled) | 4.51 million paise | 4.33 million paise |
| tokens per decision | 1,908 | 8,091 |
| model calls per decision | 1.0 | 3.8 |
| median summed latency | 11.2 s | 15.5 s |
| discounts | 15 of 40 | 5 of 40 |

The loop used 2.77 tool calls per decision on average, and the information it
fetched was the information the memory arm already had. So the loop paid for
turns that did not change the answer.

Where a loop could still help, and what this run cannot show: cases where the
right information depends on the first thing you look at, or where the agent can
decide that a question is not worth asking. On 40 events with a 7B model, the
agent used two or three investigation calls each time and never reached the
four-call limit. I did not measure which tools it chose.

When the agent did discount, it converted 4 of 5 (80%). Memory's discounts
converted 8 of 15 (53%). That is the most interesting number and the least
reliable: five events.

The reminder default: the agentic prompt now says a discount is a limit, not a
target, and a reminder is the default when the case is unclear. Agentic recommended
a reminder in 34 of 40 decisions. Its reminders converted 36.4%, against memory's
reminders at 37.5%, so the default did not visibly hurt recovery on reminders. It
may have cost recovery on cases where a discount would have worked, but the
sample is too small to say.

---

## Real-world use

- **Where it fits:** a decision layer in front of recovery actions, shared across
  the products that touch the same customer. The shape is: read one as-of profile,
  compute policy signals, let a cheap, bounded agent propose an action, and let a
  deterministic guardrail have the final say.
- **What would have to change first:** outcomes. The conversion and net figures
  here come from a probability table I wrote. A real deployment would learn them
  from payment webhooks and hold out a randomised control, which this project
  does not do.
- **What I would not claim:** that this improves recovery in production. It
  improves the decision record and the spend discipline in a controlled setting.

---

## Limitations

- **Synthetic data.** The customer batch is generated. Patterns like "repeat
  offender" and "cross-agent gaming" are planted on purpose, so the scenarios
  are partly defined by the generator.
- **Modelled outcomes.** Whether a customer converts depends on a hand-written
  probability table, the same table for every arm. The comparison shows what the
  policy does under those assumptions, not what customers do.
- **Notional cost.** Local calls cost $0. The cost shown is what the same tokens
  would cost at a published rate.
- **Small samples.** 40 events, five per scenario cell. Most per-scenario
  differences are one or two events. I report them as directional.
- **A 7B local model.** Stronger models may behave differently. One agentic
  decision failed validation twice in the comparison, and the output cap
  truncated reasoning in earlier smoke runs.
- **One agentic specialist.** Only cart abandonment has the loop. The subscription
  and dispute agents are single calls.
- **The memory arm's history.** As above, the memory arm had no discount history
  in the comparison database. The comparison has not been re-run since the fix.

---

## Future scope

In rough order of value:

1. Re-run the comparison with the memory arm recording its own discounts, on a
   larger sample, and report intervals rather than point estimates.
2. Replace the modelled outcomes with a randomised holdout, which measures what
   a discount causes rather than what the table assumes.
3. Try a larger local model, or a hosted one, to see whether the loop's cost
   buys anything at higher capability.
4. Extend the loop to the subscription and dispute agents, if the cart result
   justifies it. The plan would need to be written first.
5. Add a second, independent check on the guardrail's decisions, so a bug in the
   policy code is caught before it reaches a customer.
