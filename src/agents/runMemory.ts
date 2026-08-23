import { decideCartAbandonmentMemory } from "./cartAbandonmentAgent.js";
import { decideDisputeResponderMemory } from "./disputeResponderAgent.js";
import { runAgentBatch } from "./runner.js";
import { decideSubscriptionRecoveryMemory } from "./subscriptionRecoveryAgent.js";

runAgentBatch({
  mode: "memory",
  outputFile: "memory_decisions.json",
  decide: (item, customer, db) => {
    switch (item.agent) {
      case "cart_abandonment":
        return decideCartAbandonmentMemory(db, customer, item.event);
      case "subscription_recovery":
        return decideSubscriptionRecoveryMemory(db, customer, item.event);
      case "dispute_responder":
        return decideDisputeResponderMemory(db, customer, item.event);
    }
  },
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
