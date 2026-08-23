import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSyntheticBatch, summarizeBatch } from "./generator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "..", "data", "generated");

function writeJson(filename: string, data: unknown): void {
  writeFileSync(join(OUT_DIR, filename), JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });

  const batch = generateSyntheticBatch({ seed: 42, totalCustomers: 250 });

  writeJson("customers.json", batch.customers);
  writeJson("cart_abandonment_events.json", batch.cartAbandonmentEvents);
  writeJson("subscription_failure_events.json", batch.subscriptionFailureEvents);
  writeJson("dispute_events.json", batch.disputeEvents);
  writeJson("scenario_labels.json", batch.scenarioLabels);

  const summary = summarizeBatch(batch);
  writeJson("summary.json", summary);

  console.log(`Wrote synthetic batch to ${OUT_DIR}`);
  console.log(JSON.stringify(summary, null, 2));
}

main();
