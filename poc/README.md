# Framework proof of concept

A time-boxed check of whether LangGraph.js can drive a local Ollama model
through a tool-calling loop, with our metrics recorded per call. It does not
touch the existing agents, runner, or evaluation.

Run: `npm run poc:agent [customer_id]`
Metrics: `CROSS_AGENT_MEMORY_DB_PATH=data/poc/poc.sqlite npm run analyze:metrics`

## What it does

- One LangGraph.js `StateGraph`: `think` (ChatOllama with bound tools) and
  `tools` (ToolNode), with a conditional edge that loops until the model answers
  in plain text.
- One tool, `count_failed_payments`, read-only. The database is opened with
  `{ readonly: true }`; `openDb()` is never called on the committed file.
- Each model call is recorded to `llm_call_metrics` by a LangChain callback
  (`metricsCallback.ts`). It uses the same columns and `computeCost()` as the
  production instrumentation. Rows are labelled `agent=poc_failed_payments`,
  `mode=baseline`, `step_type=poc_tool_loop`. `mode` is limited to baseline or
  memory by schema, so the agent name is what separates these rows.

## Framework assessment

Checked 2026-11-18 against official pages and the npm registry.

**LangGraph.js (@langchain/langgraph 1.7.5, @langchain/core 1.4.1,
@langchain/ollama 1.3.0).** Usable for this.
- Ollama tool calling is documented: "Ollama now offers support for native tool
  calling", via `bindTools`. Source:
  https://docs.langchain.com/oss/javascript/integrations/chat/ollama
- Caveat from the same page: tool calling works "for a subset of their available
  models", and the page does not list which. qwen2.5:7b worked in this PoC.
- Status: the ChatOllama integration page lists its Serializable status as
  beta. The LangGraph overview page does not state a stability level. The
  versions are 1.x on npm. Source:
  https://docs.langchain.com/oss/javascript/langgraph/overview
- The loop needed no custom code beyond a graph with two nodes and one
  conditional edge.

**Google ADK for TypeScript (@google/adk 2.5.0, repo google/adk-js).** Not
ready for a local Ollama model without custom work.
- The README names Gemini as the model and says nothing about Ollama or other
  local providers. Source: https://github.com/google/adk-js
- The models guide documents Gemini, Apigee, Chrome on-device, and a router. It
  does not document Ollama or any local model. The documented route is to extend
  `BaseLlm` and register it. Source:
  https://github.com/google/adk-js/blob/main/docs/guides/models/index.md
- No stability wording was found on the pages read. The docs site adk.dev was
  not read.

## Second PoC, if pursued

ADK-TS would need a custom `BaseLlm` subclass for Ollama. That means a
`generateContentAsync` that calls `/api/chat`, converts ADK's function-call
parts to and from Ollama's tool format, and a connect step. The main risk is
tool-call translation, which the ADK guides do not document for local models.
That is a few hundred lines and an afternoon of testing, not built here.

## Not done

- No comparison against the existing agents. This is a framework check only.
- The tool counts failed subscription charges (`status = 'failed'`), all time.
  It does not window by date.
