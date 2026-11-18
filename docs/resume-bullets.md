# Resume bullets

Each bullet uses only figures from `docs/agentic-vs-memory-results.md` or the
test suite (101 tests passing). Where a figure depends on the synthetic dataset,
the modelled outcomes, or the local Qwen 7B model, the bullet says so.

- Built a shared customer-memory decision layer for recovery agents: as-of
  profiles, policy signals, and a deterministic guardrail with final say over
  spend, with an audit log of memory reads and decisions (SQLite, TypeScript).
  Measured on a synthetic dataset with a local Qwen 7B model.

- Built a LangGraph.js ReAct specialist for cart abandonment: a think, tool call,
  observe loop with three read-only tools, capped at four investigation calls,
  and a validated final decision that falls back to human review on error.
  Measured on a synthetic dataset with a local Qwen 7B model.

- Compared a no-memory baseline with a memory-informed arm and an agentic loop on
  40 cart events. Memory cut discount spend by 47.4%, and the agentic loop by
  83.5%, at a cost of 27.5 and 29.0 points of modelled conversion. Under the
  default outcome model the baseline earned the most net, so the spend cut did
  not pay. A sensitivity check puts the break-even at about a tenth of the
  assumed discount lift. Synthetic dataset, modelled outcomes, local Qwen 7B
  model. Five events per scenario cell, so the per-scenario result (memory kept
  the baseline's 60% conversion on a gaming-pattern cell with 61% less spend)
  is directional only.

- Measured the cost of the agentic loop against prefetched memory: 4.2 times the
  tokens and 3.6 times the notional cost per decision, for no measured gain in
  conversion (41.0% against 42.5%). Local Qwen 7B on a synthetic dataset; the cost
  is notional, since local calls cost $0.
