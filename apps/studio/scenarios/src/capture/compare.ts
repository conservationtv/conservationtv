import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

import { align, gapsOf, isBlankRow, type Alignment, type Gap, type Removal } from './align.ts';
import type { Thumbnailer } from './thumbnails.ts';

// A screenshot against its baseline's. The two are lined up row by row first (align.ts), so what only moved isn't
// counted as changed: pixels change where the rows nothing matched differ from the base's in the same place, and
// rows one side has beyond the other's count whole, as added or removed. With an image of it: the new shot faded,
// what moved tinted blue, what changed in red, a dashed red line where rows went. And, from the two pages'
// accessibility snapshots, the lines a reader would find added or gone. Shots of different widths are compared
// as they are, on a canvas the size of both.

/** The accessibility snapshot's lines that came and went, in each side's order; at most this many of each. */
const MAX_TEXT_CHANGES = 20;

export interface TextChanges {
  added: string[];
  removed: string[];
}

export interface Difference {
  /**
   * The baseline's image, copied beside the report so it stands alone, when it differs; relative to the report's
   * directory. Null when nothing changed, as the shot itself shows it.
   */
  baselineFile: string | null;
  baselineThumb: string | null;
  /** What changed in red, what moved tinted blue, over a faded copy of the new shot. Null when nothing changed. */
  diffFile: string | null;
  diffThumb: string | null;
  /** Pixels changed, and the drawn pixels of rows added or removed (at least one a row); not those that only moved. */
  pixels: number;
  /** Those pixels over all of the new shot's (or the larger shot's, when the widths differ), 0–1. */
  ratio: number;
  /** The share of the new shot in rows that moved but are otherwise the same, 0–1. */
  moved: number;
  sizeChanged: boolean;
  /** The accessibility snapshot's changes; null when either side has none. */
  text: TextChanges | null;
}

/** The parts of a shot comparing reads: its image, and its accessibility snapshot when it has one. */
export interface Compared {
  file: string;
  aria?: string | null;
}

function padded(png: PNG, width: number, height: number): Buffer {
  if (png.width === width && png.height === height) return png.data;
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < png.height; y++) {
    png.data.copy(out, y * width * 4, y * png.width * 4, (y + 1) * png.width * 4);
  }
  return out;
}

const RED: [number, number, number] = [230, 40, 40];

function paint(png: PNG, x: number, y: number, [r, g, b]: readonly [number, number, number]) {
  png.data.writeUInt32BE(((r << 24) | (g << 16) | (b << 8) | 255) >>> 0, (y * png.width + x) * 4);
}

/** The new shot faded to a pale grey, tinted blue where `tinted`. */
function fadedCopy(head: PNG, tinted: Uint8Array): PNG {
  const out = new PNG({ width: head.width, height: head.height });
  for (let p = 0; p < head.width * head.height; p++) {
    const pixel = head.data.readUInt32BE(p * 4);
    const grey = 0.3 * (pixel >>> 24) + 0.59 * ((pixel >>> 16) & 0xff) + 0.11 * ((pixel >>> 8) & 0xff);
    const v = Math.round(255 + (grey - 255) * 0.2);
    const blue = tinted[p] === 1;
    paint(out, p % head.width, Math.floor(p / head.width), [
      blue ? Math.round(v * 0.75) : v,
      blue ? Math.round(v * 0.85) : v,
      v
    ]);
  }
  return out;
}

/** The rows of a band, from `from`, `rows` of them, as one image's buffer. */
function crop(png: PNG, [x0, x1]: readonly [number, number], from: number, rows: number): Buffer {
  const width = (x1 - x0) * 4;
  const out = Buffer.alloc(width * rows);
  for (let r = 0; r < rows; r++)
    png.data.copy(out, r * width, ((from + r) * png.width + x0) * 4, ((from + r) * png.width + x1) * 4);
  return out;
}

/** How two shots differ: pixels changed, added or removed, pixels that only moved, and the picture of both. */
interface Drawn {
  pixels: number;
  moved: number;
  diff: PNG;
}

/** Each matched row that moved, marked across its band; how many pixels that is. Blank rows show nothing moving. */
function movedRows(head: PNG, alignment: Alignment, moved: Uint8Array): number {
  let pixels = 0;
  for (const { band, pairs } of alignment.bands)
    for (const [, j] of pairs.filter(([i, j]) => i !== j && !isBlankRow(head, j, band))) {
      moved.fill(1, j * head.width + band[0], j * head.width + band[1]);
      pixels += band[1] - band[0];
    }
  return pixels;
}

/** A gap's head rows against the base's facing them: pixel by pixel, red on the diff where they differ. */
function facingPixels(base: PNG, head: PNG, gap: Gap, facing: number, diff: PNG): number {
  const [x0, x1] = gap.band;
  const width = x1 - x0;
  const mask = Buffer.alloc(width * facing * 4);
  const pixels = pixelmatch(
    crop(base, gap.band, gap.base[0], facing),
    crop(head, gap.band, gap.head[0], facing),
    mask,
    width,
    facing,
    {
      threshold: 0.1,
      alpha: 0,
      diffMask: true
    }
  );
  for (let r = 0; r < facing; r++)
    for (let x = 0; x < width; x++)
      if (mask.readUInt8((r * width + x) * 4 + 3)) paint(diff, x0 + x, gap.head[0] + r, RED);
  return pixels;
}

/**
 * What rows added or removed count for: their drawn pixels, those apart from the row's own background (its first
 * pixel), and at least one each, so blank space that came or went still counts without outweighing what is drawn.
 */
function inkOf(png: PNG, [x0, x1]: readonly [number, number], from: number, to: number): number {
  let ink = 0;
  for (let y = from; y < to; y++) {
    const background = png.data.readUInt32BE((y * png.width + x0) * 4);
    let drawn = 0;
    for (let x = x0; x < x1; x++) if (png.data.readUInt32BE((y * png.width + x) * 4) !== background) drawn++;
    ink += Math.max(drawn, 1);
  }
  return ink;
}

/** A gap's changes: its facing rows compared, the rows either side has beyond the other's counted by their ink. */
function gapPixels(base: PNG, head: PNG, gap: Gap, diff: PNG): number {
  const [x0, x1] = gap.band;
  const headRows = gap.head[1] - gap.head[0];
  const baseRows = gap.base[1] - gap.base[0];
  const facing = Math.min(headRows, baseRows);
  const compared = facing > 0 ? facingPixels(base, head, gap, facing, diff) : 0;
  // Rows beyond the base's: added, marked down their left edge.
  for (let y = gap.head[0] + facing; y < gap.head[1]; y++)
    for (let x = x0; x < Math.min(x0 + 4, x1); x++) paint(diff, x, y, RED);
  return (
    compared +
    inkOf(head, gap.band, gap.head[0] + facing, gap.head[1]) +
    inkOf(base, gap.band, gap.base[0] + facing, gap.base[1])
  );
}

/** Rows the head has nothing in place of: counted by their ink, a dashed red line where they were. */
function removedPixels(base: PNG, head: PNG, removal: Removal, diff: PNG): number {
  const y = Math.min(removal.y, head.height - 1);
  for (let x = removal.band[0]; x < removal.band[1]; x++) if ((x >> 3) % 2 === 0) paint(diff, x, y, RED);
  return inkOf(base, removal.band, removal.from, removal.from + removal.rows);
}

/** The aligned comparison. */
function alignedDifference(base: PNG, head: PNG, alignment: Alignment): Drawn {
  const tinted = new Uint8Array(head.width * head.height);
  const moved = movedRows(head, alignment, tinted);
  const diff = fadedCopy(head, tinted);
  let pixels = 0;
  for (const gap of gapsOf(alignment, base, head)) pixels += gapPixels(base, head, gap, diff);
  for (const removal of alignment.removals) pixels += removedPixels(base, head, removal, diff);
  return { pixels, moved, diff };
}

/** The comparison of two shots: aligned when they are as wide, else pixel by pixel on a canvas the size of both. */
function differenceOf(previous: PNG, current: PNG): Drawn {
  // Most shots are the same to the byte: nothing to line up.
  if (current.height === previous.height && current.data.equals(previous.data))
    return { pixels: 0, moved: 0, diff: current };
  if (current.width === previous.width) return alignedDifference(previous, current, align(previous, current));
  const width = Math.max(current.width, previous.width);
  const height = Math.max(current.height, previous.height);
  const diff = new PNG({ width, height });
  const pixels = pixelmatch(padded(previous, width, height), padded(current, width, height), diff.data, width, height, {
    threshold: 0.1,
    alpha: 0.2
  });
  return { pixels, moved: 0, diff };
}

/** An accessibility snapshot's lines as a reader meets them: trimmed of the YAML's indentation and list marks. */
function snapshotLines(text: string): string[] {
  return text
    .split('\n')
    .map(line => line.trim().replace(/^- /u, '').replace(/:$/u, ''))
    .filter(Boolean);
}

/** The lines one snapshot has more often than the other, in its order. */
function beyond(lines: string[], other: string[]): string[] {
  const counts = new Map<string, number>();
  for (const line of other) counts.set(line, (counts.get(line) ?? 0) + 1);
  const out: string[] = [];
  for (const line of lines) {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1);
    else if (out.length < MAX_TEXT_CHANGES) out.push(line);
  }
  return out;
}

function textChanges(base: string, head: string): TextChanges {
  const a = snapshotLines(base);
  const b = snapshotLines(head);
  return { added: beyond(b, a), removed: beyond(a, b) };
}

function snapshotOf(dir: string, file: string | null | undefined): string | null {
  return file && existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8') : null;
}

/** The two pages' accessibility snapshots compared; null when either has none. */
function textOf(outDir: string, shot: Compared, baselineDir: string, baselineShot: Compared): TextChanges | null {
  const head = snapshotOf(outDir, shot.aria);
  const base = snapshotOf(baselineDir, baselineShot.aria);
  return head !== null && base !== null ? textChanges(base, head) : null;
}

/** No difference to show: the shot as it was. */
function unchanged(text: TextChanges | null): Difference {
  const none = { baselineFile: null, baselineThumb: null, diffFile: null, diffThumb: null };
  return { ...none, pixels: 0, ratio: 0, moved: 0, sizeChanged: false, text };
}

export async function compareShot(
  outDir: string,
  shot: Compared,
  baselineDir: string,
  baselineShot: Compared,
  thumbnailer: Thumbnailer
): Promise<Difference> {
  const currentBytes = readFileSync(join(outDir, shot.file));
  const previousBytes = readFileSync(join(baselineDir, baselineShot.file));
  // The same file (a shot taken from the baseline, or captured to the byte): nothing to decode.
  if (currentBytes.equals(previousBytes)) return unchanged(textOf(outDir, shot, baselineDir, baselineShot));
  const current = PNG.sync.read(currentBytes);
  const previous = PNG.sync.read(previousBytes);
  const sizeChanged = current.width !== previous.width || current.height !== previous.height;
  const text = textOf(outDir, shot, baselineDir, baselineShot);
  const { pixels, moved, diff } = differenceOf(previous, current);
  const area = Math.max(current.width * current.height, previous.width * previous.height, diff.width * diff.height);
  const ratio = pixels / area;
  const movedShare = moved / area;
  if (pixels === 0) return { ...unchanged(text), moved: movedShare, sizeChanged, ratio };

  // Only what changed keeps its baseline and diff beside the report, each with a thumbnail for its card.
  const copied = join('baseline', baselineShot.file);
  mkdirSync(dirname(join(outDir, copied)), { recursive: true });
  copyFileSync(join(baselineDir, baselineShot.file), join(outDir, copied));
  const diffFile = join('diffs', shot.file.replace(/^shots\//u, ''));
  mkdirSync(dirname(join(outDir, diffFile)), { recursive: true });
  writeFileSync(join(outDir, diffFile), PNG.sync.write(diff));
  return {
    baselineFile: copied,
    baselineThumb: await thumbnailer.make(outDir, copied),
    diffFile,
    diffThumb: await thumbnailer.make(outDir, diffFile),
    pixels,
    ratio,
    moved: movedShare,
    sizeChanged,
    text
  };
}
