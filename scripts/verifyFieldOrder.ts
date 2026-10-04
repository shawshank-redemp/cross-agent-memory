// ONE real API call, to answer one question that cannot be answered by
// reasoning about it: does structured output emit fields in schema DECLARATION
// order?
//
// This matters because the decision schema declares `reasoning` first
// deliberately. If the model emits `action` first and `reasoning` afterwards,
// then the reasoning is a post-hoc justification of a decision already made,
// and the schema ordering is decorative. Key order does not survive
// JSON.parse, so this inspects the RAW response text via decideRaw() — the
// same production call path decide() uses, not a replica of it.
//
// Run: npx tsx --env-file-if-exists=.env scripts/verifyFieldOrder.ts
import { decideRaw, MODEL } from "../src/agents/claudeClient.js";
import { CartAbandonmentDecisionSchema } from "../src/agents/schema.js";

const SYSTEM = `You are Razorpay's Cart Abandonment recovery agent.

Actions:
- "send_discount": offer a discount to recover the cart.
- "send_reminder": a plain nudge, no discount.
- "no_action": nothing to do.`;

const USER = JSON.stringify(
  {
    customer: { customer_id: "cust_probe", name: "Field Order Probe", plan_tier: "standard" },
    event: {
      order_id: "order_probe",
      amount: 250000,
      amount_paid: 0,
      status: "attempted",
      attempts: 2,
      last_method: "card",
      last_error_code: "BAD_REQUEST_ERROR",
    },
  },
  null,
  2,
);

async function main(): Promise<void> {
  console.log(`model: ${MODEL}`);
  const { rawText, parsed } = await decideRaw(SYSTEM, USER, CartAbandonmentDecisionSchema);

  if (!rawText) {
    console.log("FAIL: no raw text block on the response — cannot observe field order.");
    process.exit(1);
  }

  console.log("\n--- RAW RESPONSE TEXT ---");
  console.log(rawText.length > 1200 ? `${rawText.slice(0, 1200)}\n...[truncated for display]` : rawText);

  // Order of first appearance of each top-level key in the raw text.
  const keys = [
    "reasoning",
    "memory_factors_used",
    "action",
    "committed_spend_paise",
    "escalate_to_human",
    "escalation_reason",
  ];
  const positions = keys
    .map((k) => ({ key: k, at: rawText.indexOf(`"${k}"`) }))
    .filter((p) => p.at >= 0)
    .sort((a, b) => a.at - b.at);

  console.log("\n--- OBSERVED FIELD ORDER (raw text) ---");
  positions.forEach((p, i) => console.log(`  ${i + 1}. ${p.key}  (char ${p.at})`));

  const missing = keys.filter((k) => !positions.some((p) => p.key === k));
  if (missing.length) console.log(`  (not found in raw text: ${missing.join(", ")})`);

  const reasoningFirst = positions[0]?.key === "reasoning";
  const actionAt = positions.find((p) => p.key === "action")?.at ?? -1;
  const reasoningAt = positions.find((p) => p.key === "reasoning")?.at ?? -1;

  console.log(
    `\nRESULT: reasoning ${reasoningFirst ? "IS" : "is NOT"} the first field; ` +
      `reasoning ${reasoningAt < actionAt ? "precedes" : "does NOT precede"} action.`,
  );
  console.log(`reasoning length: ${String(parsed.reasoning).length} chars`);
  process.exit(reasoningFirst && reasoningAt < actionAt ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
