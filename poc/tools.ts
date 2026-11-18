import Database from "better-sqlite3";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

// The one tool the PoC agent has. READ-ONLY by construction: the database is
// opened with { readonly: true }, and this module never calls openDb(), whose
// CREATE TABLE IF NOT EXISTS would write to the file.
export function openReadOnly(path: string): Database.Database {
  return new Database(path, { readonly: true, fileMustExist: true });
}

export function countFailedPayments(db: Database.Database, customerId: string): {
  customer_id: string;
  failed_payment_count: number;
  most_recent_failure_at: string | null;
} {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n, MAX(created_at) AS latest
       FROM subscription_failure_events
       WHERE customer_id = ? AND status = 'failed'`,
    )
    .get(customerId) as { n: number; latest: string | null };
  return {
    customer_id: customerId,
    failed_payment_count: row.n,
    most_recent_failure_at: row.latest,
  };
}

export function makeFailedPaymentTool(db: Database.Database) {
  return tool(
    async ({ customer_id }: { customer_id: string }) => {
      return JSON.stringify(countFailedPayments(db, customer_id));
    },
    {
      name: "count_failed_payments",
      description:
        "Read-only lookup. Returns how many subscription charges have failed for a customer, and when the most recent one failed. Use it before deciding how to recover a customer.",
      schema: z.object({
        customer_id: z.string().describe("The customer's id, for example cust_000123."),
      }),
    },
  );
}
