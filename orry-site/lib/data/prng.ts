/* A small seeded PRNG (mulberry32) so the fixtures are the same on every run. */
export type Rng = {
  (): number;                                   // [0, 1)
  int(lo: number, hi: number): number;          // inclusive
  pick<T>(xs: readonly T[]): T;
  weighted(ws: readonly number[]): number;      // index
  shuffle<T>(xs: T[]): T[];                     // in place
};

export function rng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (() => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }) as Rng;
  next.int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  next.pick = xs => xs[Math.floor(next() * xs.length)];
  next.weighted = ws => {
    const total = ws.reduce((s, w) => s + w, 0);
    let r = next() * total;
    for (let i = 0; i < ws.length; i++) { r -= ws[i]; if (r < 0) return i; }
    return ws.length - 1;
  };
  next.shuffle = xs => {
    for (let i = xs.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [xs[i], xs[j]] = [xs[j], xs[i]]; }
    return xs;
  };
  return next;
}
