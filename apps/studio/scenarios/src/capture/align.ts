import type { PNG } from 'pngjs';

// Two shots of a page lined up row by row, as a text diff lines up lines, so what only moved (a section shifted down
// by one added above it) is told apart from what changed. The page is split into bands at the gutters that run down
// it (the gap between the sidebar and the page's pane), as each scrolls and grows on its own; in each band the rows
// are matched by patience diff: rows found once on each side anchor it (blank rows and repeated rules never do), the
// matches grow up and down from each anchor, and the stretches between are matched the same way. Rows the same but
// for rendering noise (a gradient dithered a shade apart) count as the same.

/** A run of columns, [from, to). */
export type Band = readonly [number, number];

/** What the base had in a band that the head doesn't: `rows` of the base's rows from `from`, gone from above the head's row `y`. */
export interface Removal {
  band: Band;
  y: number;
  from: number;
  rows: number;
}

/** A band's rows of the head paired with the base's, [base row, head row], in order down the page. */
export interface AlignedBand {
  band: Band;
  pairs: RowPair[];
}

export interface Alignment {
  bands: AlignedBand[];
  removals: Removal[];
}

/** The most a channel may differ between two rows that are still the same row. */
const NOISE = 3;
/** A gutter: this many columns side by side, each nearly all one colour down both shots. */
const GUTTER_WIDTH = 8;
const GUTTER_SHARE = 0.97;
/** How deep the stretches between anchors are matched again before they are left unmatched. */
const MAX_DEPTH = 6;

function pixelAt(png: PNG, x: number, y: number): number {
  return png.data.readUInt32BE((y * png.width + x) * 4);
}

/** Whether a column is one colour down nearly all of a shot. */
function isGutter(png: PNG, x: number): boolean {
  // The column's majority colour by Boyer–Moore's vote (one pass, nothing kept but a candidate), then counted.
  let candidate = 0;
  let votes = 0;
  for (let y = 0; y < png.height; y++) {
    const value = pixelAt(png, x, y);
    if (votes === 0) candidate = value;
    votes += value === candidate ? 1 : -1;
  }
  let count = 0;
  for (let y = 0; y < png.height; y++) if (pixelAt(png, x, y) === candidate) count++;
  return count >= GUTTER_SHARE * png.height;
}

/** The bands between the gutters both shots share. */
function bandsOf(base: PNG, head: PNG): Band[] {
  const width = Math.min(base.width, head.width);
  const gutter = Array.from({ length: width }, (_, x) => isGutter(base, x) && isGutter(head, x));
  const bands: Band[] = [];
  let from = 0;
  let x = 0;
  while (x < width) {
    // Each run of gutter columns wide enough ends the band before it and starts the next after it; narrower runs are
    // only gaps inside a band (between words, say).
    let run = 0;
    while (x + run < width && gutter[x + run]) run++;
    if (run >= GUTTER_WIDTH) {
      if (x > from) bands.push([from, x]);
      from = x + run;
    }
    x += Math.max(run, 1);
  }
  if (width > from) bands.push([from, width]);
  return bands;
}

/** Each row's hash across a band, its colours coarsened so rendering noise mostly hashes alike. */
function rowHashes(png: PNG, [from, to]: Band): Uint32Array {
  const hashes = new Uint32Array(png.height);
  for (let y = 0; y < png.height; y++) {
    let hash = 2166136261;
    for (let x = from; x < to; x++) hash = Math.imul(hash ^ (pixelAt(png, x, y) & 0xf0f0f000), 16777619);
    hashes[y] = hash >>> 0;
  }
  return hashes;
}

/** A base row and the head row matched to it. */
export type RowPair = [number, number];

/** The pile a candidate goes on in patience sorting: the first whose top's head row isn't above its own. */
function pileFor(tops: number[], candidates: RowPair[], headRow: number): number {
  let low = 0;
  let high = tops.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    const top = candidates[tops[middle] ?? -1];
    if (top && top[1] < headRow) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** The longest run of candidates whose head rows go down the page as their base rows do (patience sorting). */
function longestIncreasing(candidates: RowPair[]): RowPair[] {
  // Each pile's top candidate, and for each candidate the top of the pile before when it was laid.
  const tops: number[] = [];
  const laidOn: number[] = [];
  candidates.forEach(([, headRow], k) => {
    const pile = pileFor(tops, candidates, headRow);
    laidOn[k] = tops[pile - 1] ?? -1;
    tops[pile] = k;
  });
  const run: RowPair[] = [];
  for (let k = tops.at(-1) ?? -1; k >= 0; k = laidOn[k] ?? -1) {
    const candidate = candidates[k];
    if (candidate) run.unshift(candidate);
  }
  return run;
}

/** Rows [from, to) of the base and of the head, still to be matched. */
interface Stretch {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

/** Where matching has got to: the next base row and head row. */
interface Cursor {
  a: number;
  b: number;
}

/** One band's rows matched by patience diff. */
class BandAligner {
  private readonly a: Uint32Array;
  private readonly b: Uint32Array;
  private readonly pairs: RowPair[] = [];

  constructor(
    private readonly base: PNG,
    private readonly head: PNG,
    private readonly band: Band
  ) {
    this.a = rowHashes(base, band);
    this.b = rowHashes(head, band);
  }

  /** The matched rows, in order down the page. */
  align(): RowPair[] {
    this.walk({ a0: 0, a1: this.base.height, b0: 0, b1: this.head.height }, 0);
    return this.pairs.sort((p, q) => p[1] - q[1]);
  }

  /** Whether two rows are the same across the band, but for rendering noise. */
  private same(i: number, j: number): boolean {
    // Pixel by pixel; where two differ, each colour channel (the top three bytes) may be off by the noise and no more.
    for (let x = this.band[0]; x < this.band[1]; x++) {
      const p = pixelAt(this.base, x, i);
      const q = pixelAt(this.head, x, j);
      if (p === q) continue;
      for (let shift = 8; shift < 32; shift += 8)
        if (Math.abs(((p >>> shift) & 0xff) - ((q >>> shift) & 0xff)) > NOISE) return false;
    }
    return true;
  }

  /** A stretch matched: its shared start and end where they are, then what is between by its anchors. */
  private walk(stretch: Stretch, depth: number) {
    const s = { ...stretch };
    while (s.a0 < s.a1 && s.b0 < s.b1 && this.same(s.a0, s.b0)) this.pairs.push([s.a0++, s.b0++]);
    while (s.a1 > s.a0 && s.b1 > s.b0 && this.same(s.a1 - 1, s.b1 - 1)) this.pairs.push([--s.a1, --s.b1]);
    if (s.a0 < s.a1 && s.b0 < s.b1 && depth < MAX_DEPTH) this.matchAnchors(s, depth);
  }

  private hashA(row: number): number {
    return this.a[row] ?? -1;
  }

  private hashB(row: number): number {
    return this.b[row] ?? -1;
  }

  /** Rows found once in each side of a stretch, and truly the same: the anchors to match it around. */
  private candidates(s: Stretch): RowPair[] {
    const inBase = new Map<number, number>();
    for (let i = s.a0; i < s.a1; i++) inBase.set(this.hashA(i), (inBase.get(this.hashA(i)) ?? 0) + 1);
    // Each hash's head row; -1 once it is found twice.
    const inHead = new Map<number, number>();
    for (let j = s.b0; j < s.b1; j++) inHead.set(this.hashB(j), inHead.has(this.hashB(j)) ? -1 : j);
    const candidates: RowPair[] = [];
    for (let i = s.a0; i < s.a1; i++) {
      // A candidate when the hash is once in the base's stretch and once in the head's, and the two rows are the
      // same (a hash can collide).
      const j = inHead.get(this.hashA(i)) ?? -1;
      if (inBase.get(this.hashA(i)) === 1 && j >= 0 && this.same(i, j)) candidates.push([i, j]);
    }
    return candidates;
  }

  /** The stretch matched around its anchors, in order: each grown up and down, what is between matched in turn. */
  private matchAnchors(s: Stretch, depth: number) {
    const anchors = longestIncreasing(this.candidates(s));
    if (!anchors.length) return;
    let next: Cursor = { a: s.a0, b: s.b0 };
    for (const anchor of anchors) next = this.growAnchor(anchor, next, s, depth);
    this.walk({ a0: next.a, a1: s.a1, b0: next.b, b1: s.b1 }, depth + 1);
  }

  /**
   * An anchor grown upwards over equal rows (what is left above it, from `from`, matched first), then downwards; the
   * rows after it, where the next anchor's turn starts. An anchor already taken by the one before is passed over.
   */
  private growAnchor([i, j]: RowPair, from: Cursor, s: Stretch, depth: number): Cursor {
    if (i < from.a || j < from.b) return from;
    let up = { a: i, b: j };
    while (up.a > from.a && up.b > from.b && this.same(up.a - 1, up.b - 1)) up = { a: up.a - 1, b: up.b - 1 };
    this.walk({ a0: from.a, a1: up.a, b0: from.b, b1: up.b }, depth + 1);
    const down = { ...up };
    while (down.a < s.a1 && down.b < s.b1 && this.same(down.a, down.b)) this.pairs.push([down.a++, down.b++]);
    return down;
  }
}

/** The two shots lined up. Shots of different widths are not: the caller compares them as they are. */
export function align(base: PNG, head: PNG): Alignment {
  const bands = bandsOf(base, head).map(band => ({ band, pairs: new BandAligner(base, head, band).align() }));
  const removals: Removal[] = [];
  for (const { band, pairs } of bands)
    for (const [[ai, bj], [an, bn]] of between(pairs, base, head))
      if (an - ai > 1 && bn - bj === 1)
        removals.push({ band, y: Math.max(bj + 1, 0), from: ai + 1, rows: an - ai - 1 });
  return { bands, removals };
}

/** Each matched pair and the next, from above the first row to below the last: the stretches between matches. */
function between(pairs: RowPair[], base: PNG, head: PNG): [RowPair, RowPair][] {
  const bounds: RowPair[] = [[-1, -1], ...pairs, [base.height, head.height]];
  return bounds.slice(1).map((next, k) => [bounds[k] ?? [-1, -1], next]);
}

/** Rows [from, to). */
export type Rows = [number, number];

/** The base's rows each unmatched stretch of the head's is compared against: the base's own stretch in the same gap. */
export interface Gap {
  band: Band;
  /** The head's rows [from, to), and the base's rows facing them [from, to) (empty when the head's are all new). */
  head: Rows;
  base: Rows;
}

/** Each band's stretches of head rows nothing matched, with what the base had in the same place. */
export function gapsOf(alignment: Alignment, base: PNG, head: PNG): Gap[] {
  const gaps: Gap[] = [];
  for (const { band, pairs } of alignment.bands)
    for (const [[ai, bj], [an, bn]] of between(pairs, base, head))
      if (bn - bj > 1) gaps.push({ band, head: [bj + 1, bn], base: [ai + 1, an] });
  return gaps;
}

/** Whether a matched row is blank across its band: one colour, so it shows nothing that could be said to move. */
export function isBlankRow(png: PNG, y: number, [from, to]: Band): boolean {
  const first = pixelAt(png, from, y);
  for (let x = from + 1; x < to; x++) if (pixelAt(png, x, y) !== first) return false;
  return true;
}
