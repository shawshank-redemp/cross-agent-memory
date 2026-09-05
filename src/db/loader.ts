import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type {
  CartAbandonmentEvent,
  Customer,
  DisputeEvent,
  SubscriptionFailureEvent,
} from "../types/index.js";

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

export interface LoadResult {
  customers: number;
  cartAbandonmentEvents: number;
  subscriptionFailureEvents: number;
  disputeEvents: number;
}

export function loadGeneratedDataIntoDb(db: Database.Database, generatedDir: string): LoadResult {
  const customers = readJson<Customer[]>(join(generatedDir, "customers.json"));
  const cartEvents = readJson<CartAbandonmentEvent[]>(join(generatedDir, "cart_abandonment_events.json"));
  const subEvents = readJson<SubscriptionFailureEvent[]>(
    join(generatedDir, "subscription_failure_events.json"),
  );
  const disputeEvents = readJson<DisputeEvent[]>(join(generatedDir, "dispute_events.json"));

  const insertCustomer = db.prepare(
    `INSERT OR REPLACE INTO customers (customer_id, name, email, contact, signup_date, plan_tier)
     VALUES (@customer_id, @name, @email, @contact, @signup_date, @plan_tier)`,
  );
  const insertCartEvent = db.prepare(
    `INSERT OR REPLACE INTO cart_abandonment_events
       (order_id, customer_id, amount, amount_paid, amount_due, currency, status, attempts,
        last_method, last_error_code, last_error_description, notes, created_at)
     VALUES (@order_id, @customer_id, @amount, @amount_paid, @amount_due, @currency, @status, @attempts,
             @last_method, @last_error_code, @last_error_description, @notes, @created_at)`,
  );
  const insertSubEvent = db.prepare(
    `INSERT OR REPLACE INTO subscription_failure_events
       (payment_id, subscription_id, customer_id, plan_id, plan_amount, plan_period, plan_interval,
        paid_count, total_count, status, method, error_code, error_description, created_at)
     VALUES (@payment_id, @subscription_id, @customer_id, @plan_id, @plan_amount, @plan_period, @plan_interval,
             @paid_count, @total_count, @status, @method, @error_code, @error_description, @created_at)`,
  );
  const insertDisputeEvent = db.prepare(
    `INSERT OR REPLACE INTO dispute_events
       (dispute_id, customer_id, payment_id, order_id, amount, dispute_reason, dispute_created_at, resolved_at, status)
     VALUES (@dispute_id, @customer_id, @payment_id, @order_id, @amount, @dispute_reason, @dispute_created_at, @resolved_at, @status)`,
  );

  const loadAll = db.transaction(() => {
    // Every per-run artifact keyed to a customer must be cleared before the
    // customers themselves, or the customer DELETE trips a foreign-key
    // constraint — and stale rows from a previous batch would otherwise be
    // read back as if they belonged to this one.
    db.exec(
      "DELETE FROM dispute_events; DELETE FROM subscription_failure_events; DELETE FROM cart_abandonment_events; DELETE FROM discount_usage; DELETE FROM intervention_outcomes; DELETE FROM audit_log; DELETE FROM agent_trace_events; DELETE FROM experiment_assignments; DELETE FROM experiment_evidence; DELETE FROM customers;",
    );
    for (const c of customers) insertCustomer.run(c);
    // `notes` is a structured object in TypeScript and in the generated JSON;
    // SQLite stores it as a JSON TEXT column. runner.ts parses it back on read.
    for (const e of cartEvents) insertCartEvent.run({ ...e, notes: JSON.stringify(e.notes) });
    for (const e of subEvents) insertSubEvent.run(e);
    for (const e of disputeEvents) insertDisputeEvent.run(e);
  });
  loadAll();

  return {
    customers: customers.length,
    cartAbandonmentEvents: cartEvents.length,
    subscriptionFailureEvents: subEvents.length,
    disputeEvents: disputeEvents.length,
  };
}
