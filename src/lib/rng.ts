// Deterministic PRNG (mulberry32) so a given seed always reproduces the same
// batch — needed so baseline-vs-memory comparison runs are diffing the same data.
export function createRng(seed: number) {
  let state = seed >>> 0;

  const next = (): number => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    int(min: number, max: number): number {
      return Math.floor(next() * (max - min + 1)) + min;
    },
    pick<T>(arr: readonly T[]): T {
      const item = arr[this.int(0, arr.length - 1)];
      if (item === undefined) throw new Error("pick() called on empty array");
      return item;
    },
    shuffle<T>(arr: readonly T[]): T[] {
      const copy = [...arr];
      for (let i = copy.length - 1; i > 0; i--) {
        const j = this.int(0, i);
        [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
      }
      return copy;
    },
    chance(probability: number): boolean {
      return next() < probability;
    },
  };
}

export type Rng = ReturnType<typeof createRng>;
