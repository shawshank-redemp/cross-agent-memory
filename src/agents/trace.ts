import type Database from "better-sqlite3";
import type { AgentType } from "../types/index.js";

export interface TraceContext {
  db: Database.Database;
  customerId: string;
  eventId: string;
  agent: AgentType;
  mode: "baseline" | "memory";
  stepOrder: number; // caller increments
}

export function emitTrace(ctx: TraceContext, stepName: string, detail: string, durationMs: number): void {
  ctx.db.prepare(
    `INSERT INTO agent_trace_events (customer_id, event_id, agent, mode, step_order, step_name, detail, duration_ms, started_at)
     VALUES (@customer_id, @event_id, @agent, @mode, @step_order, @step_name, @detail, @duration_ms, @started_at)`
  ).run({
    customer_id: ctx.customerId,
    event_id: ctx.eventId,
    agent: ctx.agent,
    mode: ctx.mode,
    step_order: ctx.stepOrder,
    step_name: stepName,
    detail,
    duration_ms: durationMs,
    started_at: new Date().toISOString(),
  });
}
