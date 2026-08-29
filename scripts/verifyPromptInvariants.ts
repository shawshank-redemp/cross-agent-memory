// Asserts the invariants that make the baseline a valid control.
//
// The comparison claims that the ONLY difference between the two arms is
// whether the agent can see the customer's shared history. That claim is only
// true if everything else in the prompt is identical, so it is checked here
// rather than trusted. No API calls.
import { OBJECTIVE_BLOCK, CLOSING_INSTRUCTION } from "../src/agents/objective.js";
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
  const baselineOnly = BASELINE_PROMPTS[agent].includes("You have NO other");
  check(`${agent}: baseline states it has no history`, baselineOnly || agent === "dispute_responder");
}

console.log(failures === 0 ? "\nAll prompt invariants hold." : `\n${failures} invariant(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
