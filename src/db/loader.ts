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
       (event_id, customer_id, order_id, amount, currency, status, cart_value, items, channel, timestamp)
     VALUES (@event_id, @customer_id, @order_id, @amount, @currency, @status, @cart_value, @items, @channel, @timestamp)`,
  );
  const insertSubEvent = db.prepare(
    `INSERT OR REPLACE INTO subscription_failure_events
       (event_id, customer_id, subscription_id, plan_id, plan_amount, cycle_number, total_count, failure_reason, status, timestamp)
     VALUES (@event_id, @customer_id, @subscription_id, @plan_id, @plan_amount, @cycle_number, @total_count, @failure_reason, @status, @timestamp)`,
  );
  const insertDisputeEvent = db.prepare(
    `INSERT OR REPLACE INTO dispute_events
       (event_id, customer_id, payment_id, order_id, amount, dispute_reason, dispute_created_at, status)
     VALUES (@event_id, @customer_id, @payment_id, @order_id, @amount, @dispute_reason, @dispute_created_at, @status)`,
  );

  const loadAll = db.transaction(() => {
    db.exec(
      "DELETE FROM dispute_events; DELETE FROM subscription_failure_events; DELETE FROM cart_abandonment_events; DELETE FROM discount_usage; DELETE FROM audit_log; DELETE FROM customers;",
    );
    for (const c of customers) insertCustomer.run(c);
    for (const e of cartEvents) insertCartEvent.run(e);
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
