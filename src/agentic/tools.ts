import type Database from "better-sqlite3";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { Customer, CartAbandonmentEvent } from "../types/index.js";
import { getMemoryProfile } from "../memory/profile.js";
import type { CustomerMemoryProfile } from "../types/memory.js";
import { buildSignalsBlock } from "../agents/signals/registry.js";
import { resolveSignalEffects, type MemorySignals } from "../agents/signals/registry.js";
import { spendCeilingPaise } from "../agents/enforcement.js";
import { DEFAULT_DISCOUNT_CAP_PERCENT } from "../agents/signals/thresholds.js";
import { CartAbandonmentDecisionSchema } from "../agents/schema.js";

// Everything the agent can see is bound to ONE customer and ONE event at
// construction. None of the tools accepts a customer or event id, so the model
// cannot ask about anyone else. Reads are as-of the triggering event's own
// timestamp, the same rule the memory arm uses (see profile.ts).
export interface AgenticToolContext {
  db: Database.Database;
  customer: Customer;
  event: CartAbandonmentEvent;
  asOf: string;
  signals: MemorySignals;
}

// The investigation tools. Read-only with respect to business state. Each
// getMemoryProfile call writes a memory_read audit row, which is the same
// record the memory arm produces, so reads stay auditable.
export const INVESTIGATION_TOOL_NAMES = [
  "get_customer_profile",
  "get_signals",
  "check_discount_policy",
] as const;

// The limit is labelled as a limit, in the tool output the model reads. This is the
// guard against the agent treating the ceiling as the amount to offer.
export const DISCOUNT_LIMIT_NOTE =
  "discount_limit_paise is a hard LIMIT enforced by policy, not a recommended amount. " +
  "Any discount above it is clamped. Choose the smallest discount likely to recover the cart, " +
  "which is usually well below the limit. blocks_discount means no discount may be offered.";

export function makeInvestigationTools(ctx: AgenticToolContext) {
  const readProfile = (): CustomerMemoryProfile =>
    getMemoryProfile(ctx.db, ctx.customer.customer_id, {
      requestedBy: "cart_abandonment",
      mode: "agentic",
      reason: `Agentic cart abandonment agent reading profile for order ${ctx.event.order_id}`,
      asOf: ctx.asOf,
      eventId: ctx.event.order_id,
    });

  const getCustomerProfile = tool(
    async () => JSON.stringify(readProfile()),
    {
      name: "get_customer_profile",
      description:
        "Returns this customer's memory profile as of the triggering order: payment counts and totals, dispute history, discount history, recovery frequency, and the recent events list. Amounts are in paise.",
      schema: z.object({}),
    },
  );

  const getSignals = tool(
    async () => {
      const profile = readProfile();
      return buildSignalsBlock(ctx.signals, {
        profile,
        agent: "cart_abandonment",
        event: {
          amount: ctx.event.amount,
          paymentAttempted: ctx.event.attempts >= 1,
          paymentErrorCode: ctx.event.last_error_code,
          agent: "cart_abandonment",
          timestamp: ctx.asOf,
        },
      });
    },
    {
      name: "get_signals",
      description:
        "Returns the policy signals computed for this customer and order: what was measured, the threshold it is judged against, and what policy permits. Statements of fact, not instructions.",
      schema: z.object({}),
    },
  );

  const checkDiscountPolicy = tool(
    async () => {
      const amount = ctx.event.amount;
      const resolved = resolveSignalEffects(ctx.signals, amount);
      const capPercent = resolved.discountCapPercent ?? DEFAULT_DISCOUNT_CAP_PERCENT;
      return JSON.stringify({
        order_amount_paise: amount,
        cap_percent: capPercent,
        discount_limit_paise: spendCeilingPaise(amount, capPercent),
        blocks_discount: resolved.blocksDiscount,
        forces_escalation: resolved.forcesEscalation,
        suppresses_outreach: resolved.suppressesOutreach,
        note: DISCOUNT_LIMIT_NOTE,
      });
    },
    {
      name: "check_discount_policy",
      description:
        "Returns the discount LIMIT in paise that policy would enforce for this order, and whether policy blocks a discount. The limit is a ceiling, not a target. It changes nothing.",
      schema: z.object({}),
    },
  );

  return [getCustomerProfile, getSignals, checkDiscountPolicy];
}

// The final answer channel. The model must call this once to finish. Its
// arguments are the existing decision schema, validated here. It is never run
// as an investigation tool: its result is the decision, which then goes through
// the deterministic guardrails.
export const SUBMIT_DECISION_TOOL = tool(
  async () => "accepted",
  {
    name: "submit_decision",
    description:
      "Submit your final decision. Call this exactly once, after investigating, with the decision fields. reasoning comes first and is at most two sentences. Amounts are in paise.",
    schema: CartAbandonmentDecisionSchema,
  },
);
