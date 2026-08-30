import cors from "cors";
import express, { type Request, type Response } from "express";
import type Database from "better-sqlite3";
import { computeMemoryProfile } from "../memory/profile.js";
import { getDataStore } from "./dataStore.js";

const RAZORPAY_PAYMENT_LINKS_URL = "https://api.razorpay.com/v1/payment_links";

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
      const countFor = (agent: string) => snapshot.recovery_frequency.find((r) => r.agent === agent)?.count ?? 0;
      return {
        event_id: e.event_id,
        timestamp: e.timestamp,
        rolling_health_score: snapshot.rolling_health_score,
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
        recovery_frequency: memoryProfile.recovery_frequency,
        rolling_health_score: memoryProfile.rolling_health_score,
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

    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
      res.status(502).json({ error: "RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set in the environment" });
      return;
    }

    try {
      const response = await fetch(RAZORPAY_PAYMENT_LINKS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
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
        res.status(502).json({ error: razorpayErrorMessage(body, response.status) });
        return;
      }

      const link = body as { short_url?: string; id?: string; status?: string };
      res.json({ short_url: link.short_url, id: link.id, status: link.status });
    } catch (err) {
      // Network failure, DNS, TLS — anything that means we never got an answer.
      res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/customers/:id/trace", (req: Request, res: Response) => {
    const rows = db
      .prepare(
        `SELECT event_id, agent, mode, step_order, step_name, detail, duration_ms, started_at
         FROM agent_trace_events WHERE customer_id = ? ORDER BY event_id, mode, step_order`,
      )
      .all(req.params.id);
    res.json(rows);
  });

  return app;
}
