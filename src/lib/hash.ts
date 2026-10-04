// FNV-1a 32-bit string hash — derives a deterministic RNG seed from a stable
// string key (e.g. an event_id) so the same key always produces the same
// seed, regardless of process, run order, or which arm (baseline/memory) is
// asking.
export function hashStringToSeed(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
