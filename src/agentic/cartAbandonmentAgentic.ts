import type Database from "better-sqlite3";
import { ChatOllama } from "@langchain/ollama";
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { z } from "zod";
import { Annotation, MessagesAnnotation, StateGraph, START, END } from "@langchain/langgraph";
import type { Customer, CartAbandonmentEvent } from "../types/index.js";
import { CartAbandonmentDecisionSchema } from "../agents/schema.js";
import { CONVENTIONS_BLOCK, OBJECTIVE_BLOCK } from "../agents/objective.js";
import { eventFacts } from "../agents/cartAbandonmentAgent.js";
import { computeMemorySignals, type MemorySignals } from "../agents/signals/registry.js";
import { enforcePolicy } from "../agents/memoryContext.js";
import { createLLMValidationHandoff } from "../agents/llmValidationHandoff.js";
import { POLICY_FINGERPRINT } from "../agents/policy.js";
import { appendAuditLog, getMemoryProfile } from "../memory/profile.js";
import { clearTrace } from "../agents/trace.js";
import { makeInvestigationTools, SUBMIT_DECISION_TOOL, INVESTIGATION_TOOL_NAMES } from "./tools.js";
import { AgenticMetricsCallback } from "./metricsCallback.js";

// ReAct specialist for the cart abandonment decision (the agentic arm).
//
// Loop: think -> call a tool -> observe -> think, until the model calls
// submit_decision. Limits, all enforced in code rather than requested of the model:
//   - at most MAX_INVESTIGATION_CALLS calls to the read-only investigation tools
//   - at most MAX_VALIDATION_FAILURES bad submissions or non-tool replies
//   - a bounded graph recursion
// Any tool failure, exhausted budget, or repeated validation failure ends the
// run in the existing human-review path. Nothing is spent.
//
// The model's decision is never final. It goes through enforcePolicy, the same
// deterministic guardrail the memory arm uses, with signals computed here from
// the database as of the event, not taken from what the model read.

export const MAX_INVESTIGATION_CALLS = 4;
export const MAX_VALIDATION_FAILURES = 2;
const RECURSION_LIMIT = 24;

type ValidatedDecision = z.infer<typeof CartAbandonmentDecisionSchema>;

export interface AgenticOutcome {
  status: "decided" | "human_review";
  action: string;
  committed_spend_paise: number | null;
  escalate_to_human: boolean;
  reasoning: string;
  policy_override: unknown;
  investigation_calls: number;
  model_calls: number;
  step_types: string[];
  failure: string | null;
}

const AgenticState = Annotation.Root({
  ...MessagesAnnotation.spec,
  decision: Annotation<ValidatedDecision | null>({
    reducer: (_previous, next) => next,
    default: () => null,
  }),
  failure: Annotation<string | null>({
    reducer: (_previous, next) => next,
    default: () => null,
  }),
  investigationCalls: Annotation<number>({
    reducer: (_previous, next) => next,
    default: () => 0,
  }),
  validationFailures: Annotation<number>({
    reducer: (_previous, next) => next,
    default: () => 0,
  }),
});

type State = typeof AgenticState.State;

function systemPrompt(): string {
  return `You are Razorpay's Cart Abandonment recovery agent, working as an investigator.
${OBJECTIVE_BLOCK}

${CONVENTIONS_BLOCK}

How to work:
- You have read-only tools for this one customer and this one order: ${INVESTIGATION_TOOL_NAMES.join(", ")}.
  You may use at most ${MAX_INVESTIGATION_CALLS} of them. Use only what you need.
- When you have enough, call submit_decision exactly once. Do not answer in plain text.
- The decision is checked by policy after you submit it. Policy can clamp a discount or
  block it, so choose the least expensive action that will work.`;
}

function caseText(customer: Customer, event: CartAbandonmentEvent): string {
  return (
    `Customer and order:\n${JSON.stringify({ customer, event }, null, 2)}\n\n` +
    `Investigate with the tools if useful, then call submit_decision.`
  );
}

function buildGraph(model: ChatOllama, tools: StructuredToolInterface[]) {
  const bound = model.bindTools(tools);
  const toolsByName = new Map(tools.map((t) => [t.name, t]));

  const think = async (state: State) => {
    const reply = await bound.invoke(state.messages);
    return { messages: [reply] };
  };

  // A reply with no tool call does not count as a decision. Say so once; a
  // second such reply is a failure.
  const nudge = async (state: State) => {
    const count = state.validationFailures + 1;
    return {
      messages: [new HumanMessage("Finish now: call submit_decision with your decision.")],
      validationFailures: count,
      failure: count >= MAX_VALIDATION_FAILURES ? "model answered without calling a tool, twice" : null,
    };
  };

  const runTools = async (state: State) => {
    const last = state.messages.at(-1) as AIMessage;
    const out: ToolMessage[] = [];
    let decision = state.decision;
    let failure = state.failure;
    let investigationCalls = state.investigationCalls;
    let validationFailures = state.validationFailures;

    for (const call of last.tool_calls ?? []) {
      const id = call.id ?? call.name;
      if (call.name === "submit_decision") {
        const parsed = CartAbandonmentDecisionSchema.safeParse(call.args);
        if (parsed.success) {
          decision = parsed.data;
          out.push(new ToolMessage({ content: "accepted", tool_call_id: id }));
        } else {
          validationFailures += 1;
          if (validationFailures >= MAX_VALIDATION_FAILURES) {
            failure = `submit_decision failed validation ${validationFailures} times`;
          }
          out.push(
            new ToolMessage({
              content: `invalid decision: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
              tool_call_id: id,
              status: "error",
            }),
          );
        }
        continue;
      }

      if (investigationCalls >= MAX_INVESTIGATION_CALLS) {
        out.push(
          new ToolMessage({
            content: `tool budget of ${MAX_INVESTIGATION_CALLS} reached; call submit_decision now`,
            tool_call_id: id,
            status: "error",
          }),
        );
        continue;
      }
      investigationCalls += 1;
      const target = toolsByName.get(call.name);
      if (!target) {
        failure = `unknown tool requested: ${call.name}`;
        out.push(new ToolMessage({ content: failure, tool_call_id: id, status: "error" }));
        continue;
      }
      try {
        const result = await target.invoke(call.args);
        out.push(new ToolMessage({ content: String(result), tool_call_id: id }));
      } catch (err) {
        failure = `tool ${call.name} failed: ${err instanceof Error ? err.message : String(err)}`;
        out.push(new ToolMessage({ content: failure, tool_call_id: id, status: "error" }));
      }
    }

    return { messages: out, decision, failure, investigationCalls, validationFailures };
  };

  const afterThink = (state: State): "tools" | "nudge" => {
    const last = state.messages.at(-1);
    return last instanceof AIMessage && (last.tool_calls?.length ?? 0) > 0 ? "tools" : "nudge";
  };
  const afterNudge = (state: State): "think" | typeof END => (state.failure ? END : "think");
  const afterTools = (state: State): "think" | typeof END =>
    state.decision || state.failure ? END : "think";

  return new StateGraph(AgenticState)
    .addNode("think", think)
    .addNode("nudge", nudge)
    .addNode("tools", runTools)
    .addEdge(START, "think")
    .addConditionalEdges("think", afterThink, ["tools", "nudge"])
    .addConditionalEdges("nudge", afterNudge, ["think", END])
    .addConditionalEdges("tools", afterTools, ["think", END])
    .compile();
}

function humanReview(
  db: Database.Database,
  customer: Customer,
  event: CartAbandonmentEvent,
  reason: string,
  counts: { investigation: number; model: number; steps: string[] },
): AgenticOutcome {
  const handoff = createLLMValidationHandoff("cart_abandonment", new Error(reason));
  appendAuditLog(db, {
    customer_id: customer.customer_id,
    agent: "cart_abandonment",
    mode: "agentic",
    entry_type: "decision",
    event_id: event.order_id,
    action: handoff.action,
    reasoning: handoff.reasoning,
    escalate_to_human: true,
    policyVersion: POLICY_FINGERPRINT,
    policyOverride: handoff.policy_override ?? null,
    metadata: {
      committed_spend_paise: null,
      investigation_calls: counts.investigation,
      model_calls: counts.model,
      fallback_reason: reason,
    },
    timestamp: event.created_at,
  });
  return {
    status: "human_review",
    action: handoff.action,
    committed_spend_paise: null,
    escalate_to_human: true,
    reasoning: handoff.reasoning,
    policy_override: handoff.policy_override ?? null,
    investigation_calls: counts.investigation,
    model_calls: counts.model,
    step_types: counts.steps,
    failure: reason,
  };
}

export interface AgenticRunOptions {
  model?: string;
  baseUrl?: string;
  pricingModel?: string;
}

export async function decideCartAbandonmentAgentic(
  db: Database.Database,
  customer: Customer,
  event: CartAbandonmentEvent,
  options: AgenticRunOptions = {},
): Promise<AgenticOutcome> {
  const eventId = event.order_id;
  const modelName = options.model ?? (process.env.OLLAMA_MODEL?.trim() || "qwen2.5:7b");
  const pricingModel = options.pricingModel ?? (process.env.OLLAMA_PRICING_MODEL?.trim() || undefined);
  const empty = { investigation: 0, model: 0, steps: [] as string[] };

  // Signals are computed here, as of the event, before the model is involved.
  // If they cannot be computed the guardrail cannot run, so no model call is made.
  const facts = { ...eventFacts(event), agent: "cart_abandonment" as const, timestamp: event.created_at };
  let signals: MemorySignals;
  try {
    const profile = getMemoryProfile(db, customer.customer_id, {
      requestedBy: "cart_abandonment",
      mode: "agentic",
      reason: `Agentic cart abandonment agent evaluating order ${eventId}`,
      asOf: event.created_at,
      eventId,
    });
    signals = computeMemorySignals(profile, facts);
  } catch (err) {
    return humanReview(db, customer, event, `signals could not be computed: ${errText(err)}`, empty);
  }

  clearTrace(db, { eventId, mode: "agentic" });
  const tools = [
    ...makeInvestigationTools({ db, customer, event, asOf: event.created_at, signals }),
    SUBMIT_DECISION_TOOL,
  ];
  const model = new ChatOllama({
    model: modelName,
    baseUrl: options.baseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
    temperature: 0,
    numPredict: 1024,
  });
  const metrics = new AgenticMetricsCallback({
    db,
    customerId: customer.customer_id,
    eventId,
    model: modelName,
    pricingModel,
  });

  let final: State;
  try {
    final = await buildGraph(model, tools).invoke(
      { messages: [new SystemMessage(systemPrompt()), new HumanMessage(caseText(customer, event))] },
      { callbacks: [metrics], recursionLimit: RECURSION_LIMIT },
    );
  } catch (err) {
    return humanReview(db, customer, event, `agent run failed: ${errText(err)}`, {
      investigation: 0,
      model: metrics.stepTypes.length,
      steps: [...metrics.stepTypes],
    });
  }

  const counts = {
    investigation: final.investigationCalls,
    model: metrics.stepTypes.length,
    steps: [...metrics.stepTypes],
  };
  if (final.failure || !final.decision) {
    return humanReview(db, customer, event, final.failure ?? "no decision submitted", counts);
  }

  // The deterministic guardrail is the final authority. It takes the model's
  // decision and the server-computed signals, and clamps, blocks or escalates.
  let enforced: ReturnType<typeof enforcePolicy<ValidatedDecision>>;
  try {
    enforced = enforcePolicy(final.decision, signals, facts, {
      db,
      customerId: customer.customer_id,
      eventId,
      agent: "cart_abandonment",
      mode: "agentic",
    }, 1);
  } catch (err) {
    return humanReview(db, customer, event, `guardrail could not evaluate: ${errText(err)}`, counts);
  }

  appendAuditLog(db, {
    customer_id: customer.customer_id,
    agent: "cart_abandonment",
    mode: "agentic",
    entry_type: "decision",
    event_id: eventId,
    action: enforced.action,
    reasoning: enforced.reasoning,
    escalate_to_human: enforced.escalate_to_human,
    policyVersion: POLICY_FINGERPRINT,
    signals: signals as unknown as object,
    policyOverride: enforced.policy_override ?? null,
    metadata: {
      committed_spend_paise: enforced.committed_spend_paise,
      memory_factors_used: enforced.memory_factors_used,
      investigation_calls: counts.investigation,
      model_calls: counts.model,
      escalation_reason: enforced.escalation_reason,
    },
    timestamp: event.created_at,
  });

  return {
    status: "decided",
    action: enforced.action,
    committed_spend_paise: enforced.committed_spend_paise,
    escalate_to_human: enforced.escalate_to_human,
    reasoning: enforced.reasoning,
    policy_override: enforced.policy_override ?? null,
    investigation_calls: counts.investigation,
    model_calls: counts.model,
    step_types: counts.steps,
    failure: null,
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
