# Decisions

Short ADR-style records. Each one says what was decided, why, and what evidence
it rests on. Evidence is either a documentation page checked on 2026-11-18 or a
measured result in this repository.

---

## ADR-1: LangGraph.js for the agent loop, not Google ADK for TypeScript

**Status:** accepted. Scope: the agentic arm only (cart abandonment).

**Context.** The agentic arm needs a think, tool call, observe loop run by a
local model. The candidates were LangGraph.js and Google ADK for TypeScript
(`@google/adk`).

**Decision.** Use LangGraph.js (`@langchain/langgraph` 1.7.5, `@langchain/core`
1.4.1, `@langchain/ollama` 1.3.0).

**Why.**
- The ChatOllama integration documents native tool calling through `bindTools`.
  Source: https://docs.langchain.com/oss/javascript/integrations/chat/ollama
  Its caveat is that tool calling works "for a subset of their available models",
  so each model has to be tested. `qwen2.5:7b` worked in the proof of concept.
- ADK for TypeScript documents Gemini and a few hosted or on-device options. It
  does not document Ollama or any local model. Its documented route is to extend
  `BaseLlm` and implement the model calls yourself. Sources:
  https://github.com/google/adk-js and
  https://github.com/google/adk-js/blob/main/docs/guides/models/index.md
- Neither page gives a stability level in the text read. The LangChain Ollama
  integration is marked "beta" for serialization.

**Consequences.** The ReAct loop depends on LangGraph's graph and state APIs,
which change between major versions. The versions are pinned exactly. Adopting
ADK later would mean writing an Ollama `BaseLlm` adapter, which the proof of
concept estimated at a few hundred lines with testing (`poc/README.md`).

---

## ADR-2: Local Ollama models for the comparison

**Status:** accepted.

**Context.** The comparison runs many model calls per arm. The first design
assumed a hosted API.

**Decision.** Run the comparison on a local model served by Ollama, currently
`qwen2.5:7b`, for all arms. Compare runs refuse to start unless the provider is
Ollama and every arm resolves to the same model
(`src/agentic/providerGuard.ts`).

**Why.**
- No API spend, and no data leaves the machine. This matters for the research
  question, because nothing in the comparison depends on a metered provider.
- Every arm uses one provider and one model, so the arms differ only in what the
  agent is allowed to see and do. A guard enforces this rather than convention.
- Ollama supports native tool calling for the models that have it. The loop uses
  that path.

**Consequences.**
- The cost reported is **notional**. Local calls cost $0. The figure is what the
  same token counts would cost at a published paid rate (`src/llm/pricing.ts`).
- A 7B model is much weaker than a frontier model. In the 40-event comparison,
  one agentic decision failed validation twice and went to human review. In
  earlier smoke runs, reasoning was sometimes cut off by the output cap. Both are
  model-quality limits, not pipeline bugs.
- Conclusions are about this model. They do not transfer to a larger one without
  a new run.

---

## ADR-3: Guardrails stay deterministic and final

**Status:** accepted, and enforced in code.

**Context.** An agent can be made to reason well about discounts, and still
propose one the business should not give: an amount above the policy ceiling, a
discount for a customer the signals say to block, or a missing escalation.

**Decision.** Every decision, from every arm, goes through the same deterministic
guardrail (`enforcePolicy`, with the universal layer first). It clamps spend to
the ceiling, blocks discounts when a signal says so, and forces escalation. The
model's output is never the final word. The agentic arm adds no exemption. The
guardrail uses signals computed server-side as of the event, not whatever the
agent read through its tools.

**Why.**
- The model proposes and the code disposes. A rule written in code cannot be
  argued past by a persuasive reasoning field.
- It keeps the arms comparable. If the agentic arm had its own rules, the
  comparison would measure those rules, not the agent.
- It is auditable. The trace records the proposed decision and the final one
  side by side, and `policy_override` says what changed and why.

**Consequences.** Tool-using agents can still pick a worse action within the
allowed set. The guardrail bounds the harm; it does not improve the choice.
Improving the choice is the agent's job, and it is measured separately.

---

## ADR-4: Compare the agentic arm with a memory arm that has the same information

**Status:** accepted.

**Context.** A reader could fairly ask whether an agent that fetches information
with tools does better than the same information given up front. Comparing it
with a baseline that has no information would measure the information, not the
loop.

**Decision.** The memory arm receives, in its prompt, the same customer profile
and policy signals that the agentic arm can fetch through its tools. Both read as
of the event's own timestamp, from the same functions. The difference is
therefore how the information arrives: all at once, or on demand.

**Why.** It isolates the question the project asks. Does an agent loop that
chooses what to look at improve decisions over having everything prefetched?
The baseline arm stays as the no-memory control.

**Consequences.**
- On 40 cart events, the agentic arm did not beat the memory arm on conversion or
  net. It used about 4.2 times the tokens per decision. See
  `docs/agentic-vs-memory-results.md`.
- The memory arm in that run had no discount history, because the compare command
  did not record discounts for it. That is fixed in commit `9c53ded`, and the
  comparison has not been re-run. The result may change once the memory arm sees
  its own history.
- The result rests on 40 events, five per scenario cell, with modelled outcomes.
  It is directional.
