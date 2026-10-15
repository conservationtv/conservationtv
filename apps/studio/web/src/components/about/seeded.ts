/**
 * A small seeded random generator (mulberry32): the same seed gives the same sequence every time, so decoration laid
 * out from it (the stars, the fireflies' wanderings) is the same on every visit and every render.
 */
export const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
