/** Shared test helpers. */

/** A small seeded PRNG (mulberry32), so generated cases are the same on every run. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)];
}

export const BACKSLASH = String.fromCharCode(0x5c);

/**
 * Writes test JSON with '~' standing for a backslash, so escape sequences in test sources are
 * plain ASCII: bs('"~u00e9"') is the six-character escape, not the character it encodes.
 */
export function bs(text: string): string {
  return text.split('~').join(BACKSLASH);
}
