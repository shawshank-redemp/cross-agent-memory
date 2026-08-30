// Prints the exact policy a run is governed by, so the writeup can cite it
// rather than describing it from memory. Read-only, no API calls.
import { describePolicy } from "../src/agents/signals/policyVersion.js";

const { version, hash, fingerprint, shape } = describePolicy();

console.log(`POLICY_FINGERPRINT   ${fingerprint}`);
console.log(`  POLICY_VERSION     ${version}   (manually bumped when behaviour changes)`);
console.log(`  thresholds hash    ${hash}       (sha256 of the canonical policy shape, first 8 hex)`);

const thresholds = shape.thresholds as Record<string, unknown>;
console.log("\nResolved thresholds:");
for (const key of Object.keys(thresholds).sort()) {
  const value = thresholds[key];
  if (value !== null && typeof value === "object") {
    console.log(`  ${key}:`);
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      console.log(`    ${k.padEnd(28)} ${String(v)}`);
    }
  } else {
    console.log(`  ${key.padEnd(38)} ${String(value)}`);
  }
}

const signals = shape.signals as { id: string; scope: string; kind: string }[];
console.log("\nRegistered signals:");
for (const s of signals) {
  console.log(`  ${s.id.padEnd(28)} ${s.scope.padEnd(9)} ${s.kind}`);
}

console.log(
  "\nNote: effects() are functions and are not hashable, so a change to a signal's\n" +
    "effect logic that touches no threshold and no signal id will NOT move the hash.\n" +
    "That is what POLICY_VERSION covers — bump it manually for such a change.",
);
