import { decideCartAbandonmentBaseline } from "./cartAbandonmentAgent.js";
import { decideDisputeResponderBaseline } from "./disputeResponderAgent.js";
import { runAgentBatch } from "./runner.js";
import { decideSubscriptionRecoveryBaseline } from "./subscriptionRecoveryAgent.js";

runAgentBatch({
  mode: "baseline",
  outputFile: "baseline_decisions.json",
  decide: (item, customer) => {
    switch (item.agent) {
      case "cart_abandonment":
        return decideCartAbandonmentBaseline(customer, item.event);
      case "subscription_recovery":
        return decideSubscriptionRecoveryBaseline(customer, item.event);
      case "dispute_responder":
        return decideDisputeResponderBaseline(customer, item.event);
    }
  },
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
