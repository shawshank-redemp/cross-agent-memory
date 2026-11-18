# Resume bullets

Each bullet uses only figures from `docs/agentic-vs-memory-results.md` or the
repository's test suite (95 tests passing). Where a figure depends on the
synthetic dataset or the local Qwen 7B model, the bullet says so.

- Built a shared customer-memory decision layer for recovery agents: as-of
  profiles, policy signals, and a deterministic guardrail with final say over
  spend, with an audit log of memory reads and decisions (SQLite, TypeScript).
  Measured on a synthetic dataset with a local Qwen 7B model.

- Built a LangGraph.js ReAct specialist for cart abandonment: a think, tool call,
  observe loop with three read-only tools, capped at four investigation calls,
  and a validated final decision that falls back to human review on error.
  Measured on a synthetic dataset with a local Qwen 7B model.

- Compared three decision arms on 40 cart events (baseline, prefetched memory,
  agentic loop). The agentic loop converted 41.0% against 42.5% for memory at
  about 4.2 times the tokens per decision (8,091 against 1,908). Synthetic
  dataset, modelled outcomes, local Qwen 7B model, five events per scenario.

- Recorded tokens, latency and notional cost for every model call, and built a
  three-arm report and per-decision summary, all reproducible from SQLite
  without new model calls. Costs are notional: local calls cost $0.
