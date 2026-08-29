import cors from "cors";
import express, { type Request, type Response } from "express";
import type Database from "better-sqlite3";
import { computeMemoryProfile } from "../memory/profile.js";
import { getDataStore } from "./dataStore.js";

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
