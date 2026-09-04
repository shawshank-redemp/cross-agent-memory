import cors from "cors";
import express, { type Request, type Response } from "express";
import type Database from "better-sqlite3";
import type {
  CartAbandonmentEvent,
  DisputeEvent,
  SubscriptionFailureEvent,
} from "../types/index.js";
import { computeMemoryProfile } from "../memory/profile.js";
import { isCartEligible, isDisputeEligible, isSubscriptionEligible } from "../db/eligibility.js";
import { readTraceDetail } from "../agents/trace.js";
import { getDataStore, type TimelineEvent } from "./dataStore.js";

const RAZORPAY_PAYMENT_LINKS_URL = "https://api.razorpay.com/v1/payment_links";

// The link already created for this event, if there is one. Used only to
// recover from Razorpay's duplicate-reference_id rejection, so a repeated click
// returns the existing link instead of an error.
async function fetchLinkByReference(
  auth: string,
  referenceId: string,
): Promise<{ short_url?: string; id?: string; status?: string } | null> {
  try {
    const url = `${RAZORPAY_PAYMENT_LINKS_URL}?reference_id=${encodeURIComponent(referenceId)}`;
    const res = await fetch(url, { headers: { Authorization: auth } });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as
      | { payment_links?: { short_url?: string; id?: string; status?: string }[] }
      | null;
    return body?.payment_links?.[0] ?? null;
  } catch {
    // The lookup is a convenience, not the operation. If it fails, the caller
    // reports Razorpay's original message rather than inventing a link.
    return null;
  }
}

interface PaymentLinkRequest {
  customerId?: unknown;
  eventId?: unknown;
  amountPaise?: unknown;
  description?: unknown;
}

// Razorpay returns errors as { error: { description, code, ... } }.
function razorpayErrorMessage(body: unknown, status: number): string {
  const description = (body as { error?: { description?: unknown } } | null)?.error?.description;
  return typeof description === "string" && description.length > 0
    ? description
    : `Razorpay responded ${status}`;
}


// The trace steps a complete replay expects, per arm. The baseline arm reads
// no memory and computes no signals, so its sequence is genuinely shorter —
// that is the control working, not a capture gap, which is why the two lists
// are separate rather than one list with holes.
const EXPECTED_STEPS: Record<"baseline" | "memory", string[]> = {
  baseline: ["agent_reasoning", "policy_override"],
  memory: [
    "read_memory_profile",
    "evaluate_policy_signals",
    "model_request",
    "agent_reasoning",
    "policy_override",
  ],
};

interface TraceRow {
  event_id: string;
  agent: string;
  mode: "baseline" | "memory";
  step_order: number;
  step_name: string;
  detail: string;
  duration_ms: number;
  started_at: string;
}

interface AuditDecisionRow {
  action: string;
  reasoning: string;
  escalate_to_human: number | null;
  policy_version: string | null;
  signals: string | null;
  policy_override: string | null;
  metadata: string | null;
  timestamp: string;
}

function parseJsonColumn(value: string | null): unknown {
  if (value == null) return null;
  try {
    return JSON.parse(value);
  } catch {
    // A malformed JSON column is corruption, not something to paper over with
    // a default. Surfaced as null and reported by the arm's `missing` list.
    return null;
  }
}

// Discriminates on `domain` so each branch narrows to its own event type and
// its own status enum — the same three-way split db/eligibility.ts defines, and
// the compiler checks the status value against the right union in each arm.
function isEligibleTimelineEvent(e: TimelineEvent): boolean {
  switch (e.domain) {
    case "cart_abandonment":
      return isCartEligible((e.detail as CartAbandonmentEvent).status);
    case "subscription_recovery":
      return isSubscriptionEligible((e.detail as SubscriptionFailureEvent).status);
    case "dispute_responder":
      return isDisputeEligible((e.detail as DisputeEvent).status);
  }
}

// One arm's replay: its captured steps, the decision row it produced, and an
// explicit account of anything expected that is not there.
function buildArm(
  db: Database.Database,
  rows: TraceRow[],
  eventId: string,
  mode: "baseline" | "memory",
) {
  const steps = rows
    .filter((r) => r.event_id === eventId && r.mode === mode)
    .sort((a, b) => a.step_order - b.step_order)
    .map((r) => ({
      step_order: r.step_order,
      step_name: r.step_name,
      duration_ms: r.duration_ms,
      started_at: r.started_at,
      // Rows written before the structured payload landed hold plain prose.
      // readTraceDetail normalises both to one shape so the UI never has to
      // know which run vintage it is looking at — but a prose-only row will
      // carry nothing beyond `summary`, and the UI must show that as a gap
      // rather than filling it in.
      detail: readTraceDetail(r.detail),
    }));

  const row = db
    .prepare(
      `SELECT action, reasoning, escalate_to_human, policy_version, signals, policy_override, metadata, timestamp
       FROM audit_log WHERE event_id = ? AND mode = ? AND entry_type = 'decision'`,
    )
    .get(eventId, mode) as AuditDecisionRow | undefined;

  const metadata = parseJsonColumn(row?.metadata ?? null) as Record<string, unknown> | null;

  const decision = row
    ? {
        action: row.action,
        reasoning: row.reasoning,
        escalate_to_human: row.escalate_to_human === 1,
        // DB column names predate the decision-schema rename; the mapping back
        // to the schema's vocabulary happens here, at the boundary, exactly as
        // the runner maps it on the way in.
        committed_spend_paise: (metadata?.discount_amount as number | null) ?? null,
        escalation_reason: (metadata?.escalation_reason as string | null) ?? null,
        memory_factors_used: (metadata?.memory_factors_used as string[] | undefined) ?? [],
        unsupported_factor_citations:
          (metadata?.unsupported_factor_citations as string[] | undefined) ?? [],
        policy_version: row.policy_version,
        signals: parseJsonColumn(row.signals),
        policy_override: parseJsonColumn(row.policy_override),
        timestamp: row.timestamp,
      }
    : null;

  const present = new Set(steps.map((s) => s.step_name));
  const missing = EXPECTED_STEPS[mode].filter((name) => !present.has(name));
  if (!decision) missing.push("decision_row");

  return { mode, steps, decision, missing };
}

export function createApp(db: Database.Database) {
  const app = express();
  const store = getDataStore();

  app.use(cors());
  app.use(express.json());

  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
  });

  app.get("/api/comparison", (_req: Request, res: Response) => {
    res.json(store.comparisonReport);
  });

  app.get("/api/customers", (_req: Request, res: Response) => {
    const list = store.customers.map((c) => {
      const id = c.customer_id;
      const baseline = store.baselineDecisionsByCustomer.get(id) ?? [];
      const memory = store.memoryDecisionsByCustomer.get(id) ?? [];
      const memoryByEvent = new Map(memory.map((d) => [d.event_id, d]));

      const hasDivergence = baseline.some((b) => {
        const m = memoryByEvent.get(b.event_id);
        if (!m) return false;
        return (
          m.escalate_to_human !== b.escalate_to_human ||
          (m.committed_spend_paise ?? 0) !== (b.committed_spend_paise ?? 0)
        );
      });

      return {
        customer_id: id,
        name: c.name,
        plan_tier: c.plan_tier,
        scenario: store.scenarioByCustomer.get(id) ?? "normal",
        eventCount: (store.eventsByCustomer.get(id) ?? []).length,
        hasDivergence,
      };
    });
    res.json(list);
  });

  app.get("/api/customers/:id", (req: Request, res: Response) => {
    const id = req.params.id as string;
    const customer = store.customers.find((c) => c.customer_id === id);
    if (!customer) {
      res.status(404).json({ error: `no customer with id ${id}` });
      return;
    }

    const memoryProfile = computeMemoryProfile(db, id, "memory");
    const baselineProfile = computeMemoryProfile(db, id, "baseline");
    const events = store.eventsByCustomer.get(id) ?? [];

    // Memory profile "as of" each event — this is what the memory-informed
    // agent actually saw at that point in the customer's real timeline
    // (causal, per the asOf fix in profile.ts), not the final accumulated
    // state. Powers the "memory accumulation over time" view.
    const profileTimeline = events.map((e) => {
      const snapshot = computeMemoryProfile(db, id, "memory", e.timestamp);
      const countFor = (agent: string) =>
        snapshot.recovery_activity.by_agent.find((r) => r.agent === agent)?.count_all_time ?? 0;
      return {
        event_id: e.event_id,
        timestamp: e.timestamp,
        dispute_count: snapshot.dispute_count,
        cart_abandonment_count: countFor("cart_abandonment"),
        subscription_recovery_count: countFor("subscription_recovery"),
        dispute_responder_count: countFor("dispute_responder"),
      };
    });

    res.json({
      customer,
      scenario: store.scenarioByCustomer.get(id) ?? "normal",
      note: store.noteByCustomer.get(id) ?? "",
      events,
      decisions: {
        baseline: store.baselineDecisionsByCustomer.get(id) ?? [],
        memory: store.memoryDecisionsByCustomer.get(id) ?? [],
      },
      profileCore: {
        dispute_count: memoryProfile.dispute_count,
        total_disputed_amount: memoryProfile.total_disputed_amount,
        recovery_activity: memoryProfile.recovery_activity,
        intervention_outcomes: memoryProfile.intervention_outcomes,
      },
      profileTimeline,
      discountHistory: {
        baseline: baselineProfile.discount_usage_history,
        memory: memoryProfile.discount_usage_history,
      },
      auditLog: {
        baseline: baselineProfile.audit_log,
        memory: memoryProfile.audit_log,
      },
    });
  });

  // DEMO-ONLY, MANUALLY TRIGGERED. Creates a real test-mode Razorpay payment
  // link for one chosen event, so a demo can show that the decision produces a
  // genuine artifact rather than a simulated one.
  //
  // This is deliberately NOT part of the pipeline. It is never called from
  // runner.ts, compareRuns.ts, or any batch script — the only route to it is a
  // human clicking the button in the dashboard, once, for one event. Calling it
  // per event would turn a 3,202-event batch into 3,202 live API calls against
  // a payments provider, which is not what the batch is for.
  //
  // Nothing is persisted to SQLite. The audit trail records what the agent
  // DECIDED; whether someone later pressed a button to materialise one of those
  // decisions as a link is a demo side effect, not evidence about the decision.
  app.post("/api/payment-links", async (req: Request, res: Response) => {
    const { customerId, eventId, amountPaise, description } = req.body as PaymentLinkRequest;

    if (typeof customerId !== "string" || typeof eventId !== "string") {
      res.status(400).json({ error: "customerId and eventId are required strings" });
      return;
    }
    if (typeof amountPaise !== "number" || !Number.isInteger(amountPaise) || amountPaise <= 0) {
      res.status(400).json({ error: "amountPaise must be a positive integer (paise)" });
      return;
    }

    const customer = store.customers.find((c) => c.customer_id === customerId);
    if (!customer) {
      res.status(404).json({ error: `no customer with id ${customerId}` });
      return;
    }

    // Razorpay's dashboard hands the credentials over labelled `key_id` and
    // `key_secret`, and that is how they tend to get pasted into a .env. Both
    // spellings are accepted so a correctly-copied key pair does not fail with
    // a message about a variable the user was never told to create; the
    // prefixed names win when both are present.
    const keyId = process.env.RAZORPAY_KEY_ID ?? process.env.key_id;
    const keySecret = process.env.RAZORPAY_KEY_SECRET ?? process.env.key_secret;
    if (!keyId || !keySecret) {
      res.status(502).json({
        error:
          "Razorpay credentials are not set. Add RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET " +
          "(or key_id / key_secret) to .env and restart the server.",
      });
      return;
    }

    try {
      const auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;
      const response = await fetch(RAZORPAY_PAYMENT_LINKS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: auth,
        },
        body: JSON.stringify({
          amount: amountPaise,
          currency: "INR",
          accept_partial: false,
          description: typeof description === "string" && description.length > 0
            ? description
            : "Recovery discount offer",
          customer: {
            name: customer.name,
            email: customer.email,
            contact: customer.contact,
          },
          // These customers are synthetic. Notifying them would mean sending
          // real SMS/email to fabricated contact details, so both are off: the
          // point is to prove the link was created, not to reach anyone.
          notify: { sms: false, email: false },
          // Makes the link traceable back to the event in the Razorpay test
          // dashboard afterwards.
          reference_id: eventId,
        }),
      });

      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        // reference_id IS the event id, deliberately — that is what makes a
        // link traceable back to the decision that produced it in the Razorpay
        // dashboard. Razorpay enforces uniqueness on it, so a SECOND click for
        // the same event is rejected.
        //
        // That rejection is not really an error: a link for this event already
        // exists, and it is the correct one to show. Fetching and returning it
        // makes the button idempotent — click it as many times as a demo needs
        // and it keeps resolving to the same real link. The alternative,
        // salting reference_id with a nonce, would clear the error by creating
        // a fresh link per click, littering the account and breaking the
        // one-link-per-event traceability the field exists for.
        const message = razorpayErrorMessage(body, response.status);
        if (/already exists/i.test(message)) {
          const existing = await fetchLinkByReference(auth, eventId);
          if (existing) {
            // Narrowed to the same three fields the create path returns.
            // Spreading Razorpay's whole object here would make the response
            // shape depend on which branch ran, and hand the browser the full
            // customer contact block for no reason.
            res.json({
              short_url: existing.short_url,
              id: existing.id,
              status: existing.status,
              reused: true,
            });
            return;
          }
        }
        res.status(502).json({ error: message });
        return;
      }

      const link = body as { short_url?: string; id?: string; status?: string };
      res.json({ short_url: link.short_url, id: link.id, status: link.status, reused: false });
    } catch (err) {
      // Network failure, DNS, TLS — anything that means we never got an answer.
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ONE RESPONSE PER REPLAYED EVENT, carrying everything the six replay steps
  // need for BOTH arms.
  //
  // The steps are assembled here rather than in the browser because the join is
  // a database join — trace rows, the audit_log decision row, and the event's
  // own row live in three places, keyed differently. Doing it client-side would
  // mean three round trips and a reimplementation of the event-id normalisation
  // the runner already owns.
  //
  // NOTHING IS SUBSTITUTED WHEN A STEP IS ABSENT. Each arm reports a `missing`
  // list naming the expected steps that have no row, and every field that could
  // not be read comes back null. A replay of an event that was never decided
  // must look empty, not plausible — an invented number here would be
  // indistinguishable from a real one on screen, which is the one failure this
  // page cannot afford.
  app.get("/api/customers/:id/trace", (req: Request, res: Response) => {
    const customerId = req.params.id as string;
    const customer = store.customers.find((c) => c.customer_id === customerId);
    if (!customer) {
      res.status(404).json({ error: `no customer with id ${customerId}` });
      return;
    }

    const rows = db
      .prepare(
        `SELECT event_id, agent, mode, step_order, step_name, detail, duration_ms, started_at
         FROM agent_trace_events WHERE customer_id = ? ORDER BY event_id, mode, step_order`,
      )
      .all(customerId) as TraceRow[];

    const events = store.eventsByCustomer.get(customerId) ?? [];
    const tracedEventIds = new Set(rows.map((r) => r.event_id));

    // Which events this endpoint can replay at all: the ones with an open
    // recovery question (the same definition the runner decides on — see
    // db/eligibility.ts) AND at least one captured trace row.
    const replayable = events
      .filter((e) => isEligibleTimelineEvent(e) && tracedEventIds.has(e.event_id))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const requested = typeof req.query.eventId === "string" ? req.query.eventId : null;
    const selected = requested
      ? (replayable.find((e) => e.event_id === requested) ?? null)
      : (replayable[replayable.length - 1] ?? null);

    if (requested && !selected) {
      res.status(404).json({
        error: `no replayable trace for event ${requested} on customer ${customerId}`,
        replayableEventIds: replayable.map((e) => e.event_id),
      });
      return;
    }

    res.json({
      customer,
      scenario: store.scenarioByCustomer.get(customerId) ?? null,
      note: store.noteByCustomer.get(customerId) ?? "",
      // The customer's whole timeline, for the rail. Not filtered to eligible
      // events: the rail is a history, and a paid order or a settled dispute is
      // exactly the context that explains the signals.
      timeline: events,
      replayableEventIds: replayable.map((e) => e.event_id),
      event: selected,
      arms: selected
        ? {
            baseline: buildArm(db, rows, selected.event_id, "baseline"),
            memory: buildArm(db, rows, selected.event_id, "memory"),
          }
        : null,
    });
  });

  return app;
}
