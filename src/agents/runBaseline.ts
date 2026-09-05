import { CART_BASELINE_SYSTEM_PROMPT, decideCartAbandonmentBaseline } from "./cartAbandonmentAgent.js";
import { DISPUTE_BASELINE_SYSTEM_PROMPT, decideDisputeResponderBaseline } from "./disputeResponderAgent.js";
import {
  SUBSCRIPTION_BASELINE_SYSTEM_PROMPT,
  decideSubscriptionRecoveryBaseline,
} from "./subscriptionRecoveryAgent.js";
import { baselineUserContent, prefetchedRemaining, setPrefetchedBaseline } from "./baselinePrefetch.js";
import { decideBatch, type BatchRequest } from "./claudeClient.js";
import { CartAbandonmentDecisionSchema, DisputeResponderDecisionSchema, SubscriptionRecoveryDecisionSchema } from "./schema.js";
import { runAgentBatch } from "./runner.js";

const SYSTEM_PROMPT = {
  cart_abandonment: CART_BASELINE_SYSTEM_PROMPT,
  subscription_recovery: SUBSCRIPTION_BASELINE_SYSTEM_PROMPT,
  dispute_responder: DISPUTE_BASELINE_SYSTEM_PROMPT,
} as const;

// --no-batch falls back to live calls, at full price. Kept because the Batch API
// carries no latency guarantee — most batches finish inside an hour, the cap is
// 24 — and a run that has to finish now should be able to say so.
const useBatch = !process.argv.includes("--no-batch");

runAgentBatch({
  mode: "baseline",
  outputFile: "baseline_decisions.json",

  // THE WHOLE BASELINE ARM IN ONE BATCH, at half price.
  //
  // Safe because a baseline request is built from {customer, event} and nothing
  // else: no profile, no signals, no prior decisions. Every call is independent,
  // so submitting them together produces the same answers as calling them one at
  // a time. The memory arm has no equivalent — measured on this batch, 1,042 of
  // its 1,724 decisions are a customer's second or later event and read state
  // that earlier decisions write.
  //
  // Enforcement is untouched: the runner still walks events in order and applies
  // the guardrail per event as it goes, so spend bounds, the run breakers, audit
  // rows and traces behave exactly as on the live path. Only the model's answer
  // is resolved earlier.
  //
  // Three schemas, one batch: each request carries its own agent's system prompt,
  // and the per-agent schema is applied when its result is parsed.
  prepare: useBatch
    ? async (toProcess, customerById) => {
        const requests: BatchRequest[] = [];
        for (const item of toProcess) {
          const customer = customerById.get(item.event.customer_id);
          if (!customer) continue;
          requests.push({
            customId: item.event_id,
            system: SYSTEM_PROMPT[item.agent],
            userContent: baselineUserContent(customer, item.event),
          });
        }
        console.log(
          `Batch API: submitting ${requests.length} baseline request(s) at 50% of standard price.\n` +
            `  Most batches finish within the hour; the cap is 24. Pass --no-batch to run live instead.`,
        );
        const byAgent = new Map(toProcess.map((i) => [i.event_id, i.agent]));
        // Each agent has its own action enum, so results are parsed against the
        // schema belonging to the event they came from.
        const resolved = new Map<string, unknown>();
        for (const [agent, schema] of [
          ["cart_abandonment", CartAbandonmentDecisionSchema],
          ["subscription_recovery", SubscriptionRecoveryDecisionSchema],
          ["dispute_responder", DisputeResponderDecisionSchema],
        ] as const) {
          const subset = requests.filter((r) => byAgent.get(r.customId) === agent);
          if (subset.length === 0) continue;
          const got = await decideBatch(subset, schema, (done, total) =>
            console.log(`  ${agent}: ${done}/${total} resolved`),
          );
          for (const [k, v] of got) resolved.set(k, v);
        }
        setPrefetchedBaseline(resolved);
        console.log(
          `Batch resolved ${resolved.size}/${requests.length}. ` +
            `Any shortfall falls through to live calls, one per event.`,
        );
        void prefetchedRemaining;
      }
    : undefined,

  decide: (item, customer, db) => {
    switch (item.agent) {
      case "cart_abandonment":
        return decideCartAbandonmentBaseline(db, customer, item.event);
      case "subscription_recovery":
        return decideSubscriptionRecoveryBaseline(db, customer, item.event);
      case "dispute_responder":
        return decideDisputeResponderBaseline(db, customer, item.event);
    }
  },
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
