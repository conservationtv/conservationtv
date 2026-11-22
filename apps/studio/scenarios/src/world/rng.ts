import { createHash } from 'node:crypto';

// Randomness keyed by where it is used, not by how much was drawn before. Each entity draws from a stream of its own,
// seeded from the world's seed and its path (`seed/network/2/camera/0`), so generating one more of something, or a new
// field on it, leaves every other entity as it was: its ID, name and health, and so its screenshot.

/** An inclusive range to draw a count from. */
export type Range = readonly [min: number, max: number];

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(readonly key: string) {
    const digest = createHash('sha256').update(key).digest();
    this.a = digest.readUInt32LE(0);
    this.b = digest.readUInt32LE(4);
    this.c = digest.readUInt32LE(8);
    this.d = digest.readUInt32LE(12);
  }

  /** The stream for a part of this one, unaffected by anything drawn from this one or its other parts. */
  child(...parts: (string | number)[]): Rng {
    return new Rng(`${this.key}/${parts.join('/')}`);
  }

  /** A float in [0, 1), from sfc32. */
  float(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4_294_967_296;
  }

  /** An integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.float() * (max - min + 1));
  }

  range([min, max]: Range): number {
    return this.int(min, max);
  }

  chance(probability: number): boolean {
    return this.float() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error(`Nothing to pick from (${this.key})`);
    // SAFETY: the index is within the non-empty array.
    return items[Math.floor(this.float() * items.length)] as T;
  }

  /** One of the keys, by its weight. */
  weighted<K extends string>(weights: Readonly<Record<K, number>>): K {
    // SAFETY: `weights` is a record keyed by K, so its own entries are K and their weights.
    const entries = Object.entries(weights) as [K, number][];
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    let point = this.float() * total;
    for (const [key, weight] of entries) {
      point -= weight;
      if (point < 0) return key;
    }
    // SAFETY: there is at least one entry whenever the total is positive; rounding lands on the last.
    return entries[entries.length - 1]![0];
  }

  /** `count` distinct items, in a random order. */
  sample<T>(items: readonly T[], count: number): T[] {
    const pool = [...items];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(this.float() * (i + 1));
      // SAFETY: i and j are both within the pool, which noUncheckedIndexedAccess can't see.
      [pool[i], pool[j]] = [pool[j] as T, pool[i] as T];
    }
    return pool.slice(0, Math.max(0, count));
  }

  hex(bytes: number): string {
    let out = '';
    for (let i = 0; i < bytes; i++) out += this.int(0, 255).toString(16).padStart(2, '0');
    return out;
  }

  base64url(bytes: number): string {
    const buffer = Buffer.alloc(bytes);
    for (let i = 0; i < bytes; i++) buffer[i] = this.int(0, 255);
    return buffer.toString('base64url');
  }

  /**
   * A UUIDv7 for something created at `at`, as the API's tables make them (Postgres' uuidv7()): ordered by creation, so
   * lists the API returns oldest first by ID come out in creation order here too.
   */
  uuid(at: Date): string {
    const time = at.getTime().toString(16).padStart(12, '0');
    const random = this.hex(10);
    const variant = ((Number.parseInt(random.slice(3, 4), 16) & 0x3) | 0x8).toString(16);
    return [
      time.slice(0, 8),
      time.slice(8, 12),
      `7${random.slice(0, 3)}`,
      `${variant}${random.slice(4, 7)}`,
      random.slice(8, 20).padEnd(12, '0')
    ].join('-');
  }
}
