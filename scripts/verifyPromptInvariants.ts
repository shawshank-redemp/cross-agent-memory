// Asserts the invariants that make the baseline a valid control.
//
// The comparison claims that the ONLY difference between the two arms is
// whether the agent can see the customer's shared history. That claim is only
// true if everything else in the prompt is identical, so it is checked here
// rather than trusted. No API calls.
import { CLOSING_INSTRUCTION, DISPUTE_COST_MODEL, OBJECTIVE_BLOCK } from "../src/agents/objective.js";
import { CART_BASELINE_SYSTEM_PROMPT, CART_MEMORY_SYSTEM_PROMPT } from "../src/agents/cartAbandonmentAgent.js";
import {
  SUBSCRIPTION_BASELINE_SYSTEM_PROMPT,
  SUBSCRIPTION_MEMORY_SYSTEM_PROMPT,
} from "../src/agents/subscriptionRecoveryAgent.js";
import {
  DISPUTE_BASELINE_SYSTEM_PROMPT,
  DISPUTE_MEMORY_SYSTEM_PROMPT,
} from "../src/agents/disputeResponderAgent.js";

const BASELINE_PROMPTS = {
  cart_abandonment: CART_BASELINE_SYSTEM_PROMPT,
  subscription_recovery: SUBSCRIPTION_BASELINE_SYSTEM_PROMPT,
  dispute_responder: DISPUTE_BASELINE_SYSTEM_PROMPT,
} as const;
const MEMORY_PROMPTS = {
  cart_abandonment: CART_MEMORY_SYSTEM_PROMPT,
  subscription_recovery: SUBSCRIPTION_MEMORY_SYSTEM_PROMPT,
  dispute_responder: DISPUTE_MEMORY_SYSTEM_PROMPT,
} as const;

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// 1. Both arms carry the objective, byte-for-byte.
for (const agent of Object.keys(BASELINE_PROMPTS) as (keyof typeof BASELINE_PROMPTS)[]) {
  const baseline = BASELINE_PROMPTS[agent];
  const memory = MEMORY_PROMPTS[agent];
  check(`${agent}: baseline system prompt contains OBJECTIVE_BLOCK verbatim`, baseline.includes(OBJECTIVE_BLOCK));
  check(`${agent}: memory system prompt contains OBJECTIVE_BLOCK verbatim`, memory.includes(OBJECTIVE_BLOCK));
}

// 2. The objective is arm-neutral: it must not mention memory at all, or the
//    baseline is being told about a capability it does not have.
const FORBIDDEN_IN_OBJECTIVE = [
  "memory",
  "dispute",
  "gaming",
  "churn",
  "history",
  "profile",
  "signal",
  "policy_signals",
];
for (const word of FORBIDDEN_IN_OBJECTIVE) {
  check(
    `objective is arm-neutral: does not mention "${word}"`,
    !OBJECTIVE_BLOCK.toLowerCase().includes(word),
  );
}

// 3. The objective must not leak the scorer's cost table. An agent optimising
//    against the same numbers that grade it is marking its own homework.
check(
  "objective states costs as an ordering, not as rupee figures",
  !/₹|paise|\b\d{3,}\b/.test(OBJECTIVE_BLOCK),
);

// 4. The closing instruction is shared, and non-trivial.
check("closing instruction is non-empty and shared", CLOSING_INSTRUCTION.length > 20);

// 5. The memory arm's extra content must be memory-specific only. Anything the
//    baseline lacks BESIDES history is a confound.
for (const agent of Object.keys(MEMORY_PROMPTS) as (keyof typeof MEMORY_PROMPTS)[]) {
  const baselineOnly = /no\s+(?:cross-customer\s+)?history|no\s+cross-customer/i.test(BASELINE_PROMPTS[agent]);
  check(`${agent}: baseline states it has no history`, baselineOnly);
}

// 6. The dispute cost model: shared across both dispute arms, absent from the
//    other two agents, and arm-neutral like the objective.
check(
  "dispute baseline prompt contains DISPUTE_COST_MODEL verbatim",
  BASELINE_PROMPTS.dispute_responder.includes(DISPUTE_COST_MODEL),
);
check(
  "dispute memory prompt contains DISPUTE_COST_MODEL verbatim",
  MEMORY_PROMPTS.dispute_responder.includes(DISPUTE_COST_MODEL),
);
for (const agent of ["cart_abandonment", "subscription_recovery"] as const) {
  check(
    `${agent}: does NOT carry the dispute cost model (its actions do not exist there)`,
    !BASELINE_PROMPTS[agent].includes(DISPUTE_COST_MODEL) && !MEMORY_PROMPTS[agent].includes(DISPUTE_COST_MODEL),
  );
}
// Arm-neutrality: it prices two actions, and must not smuggle memory into the
// control arm by describing history or cross-dispute patterns.
for (const word of ["memory", "history", "dispute_count", "pattern", "gaming", "churn", "profile", "signal"]) {
  check(
    `dispute cost model is arm-neutral: does not mention "${word}"`,
    !DISPUTE_COST_MODEL.toLowerCase().includes(word),
  );
}
check(
  "dispute cost model states costs as an ordering, not as rupee figures",
  !/₹|paise|\b\d{3,}\b/.test(DISPUTE_COST_MODEL),
);

console.log(failures === 0 ? "\nAll prompt invariants hold." : `\n${failures} invariant(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
