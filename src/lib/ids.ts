import type { Rng } from "./rng.js";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function randomToken(rng: Rng, length: number): string {
  let token = "";
  for (let i = 0; i < length; i++) {
    token += ALPHABET[rng.int(0, ALPHABET.length - 1)];
  }
  return token;
}

// Razorpay-style entity-typed IDs: prefix_ + 14-char random token.
export function makeId(prefix: string, rng: Rng): string {
  return `${prefix}_${randomToken(rng, 14)}`;
}
