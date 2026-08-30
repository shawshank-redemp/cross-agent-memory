import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSyntheticBatch, summarizeBatch } from "./generator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "..", "data", "generated");

function writeJson(filename: string, data: unknown): void {
  writeFileSync(join(OUT_DIR, filename), JSON.stringify(data, null, 2) + "\n", "utf-8");
}

const SEED = 42;
const DEFAULT_CUSTOMERS = 1200;

// --customers=N resizes the population without editing source. The seed stays
// fixed, so a given N always reproduces the same batch; changing N changes the
// batch entirely, since every customer is drawn from one RNG stream.
function parseCustomerCount(argv: string[]): number {
  const flag = argv.find((a) => a.startsWith("--customers="));
  if (!flag) return DEFAULT_CUSTOMERS;
  const raw = flag.slice("--customers=".length);
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`--customers must be a positive integer, got "${raw}"`);
    process.exit(1);
  }
  return n;
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });

  const batch = generateSyntheticBatch({ seed: SEED, totalCustomers: parseCustomerCount(process.argv.slice(2)) });

  writeJson("customers.json", batch.customers);
  writeJson("cart_abandonment_events.json", batch.cartAbandonmentEvents);
  writeJson("subscription_failure_events.json", batch.subscriptionFailureEvents);
  writeJson("dispute_events.json", batch.disputeEvents);
  writeJson("scenario_labels.json", batch.scenarioLabels);

  const summary = summarizeBatch(batch);
  writeJson("summary.json", summary);

  console.log(`Wrote synthetic batch to ${OUT_DIR} (seed ${SEED}, ${batch.customers.length} customers)`);
  console.log(JSON.stringify(summary, null, 2));
}

main();
