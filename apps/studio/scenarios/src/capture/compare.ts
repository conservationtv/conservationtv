import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

import type { Thumbnailer } from './thumbnails.ts';

// A screenshot against its baseline's: how many pixels changed, as a share of the larger of the two, with an image of
// where. Shots of different sizes are compared on a canvas the size of both, so a page that grew counts what it grew by.

export interface Difference {
  /**
   * The baseline's image, copied beside the report so it stands alone, when it differs; relative to the report's
   * directory. Null when nothing changed, as the shot itself shows it.
   */
  baselineFile: string | null;
  baselineThumb: string | null;
  /** Changed pixels in red over a faded copy of the new shot. Null when nothing changed. */
  diffFile: string | null;
  diffThumb: string | null;
  pixels: number;
  /** Changed pixels over all of them, 0–1. */
  ratio: number;
  sizeChanged: boolean;
}

function padded(png: PNG, width: number, height: number): Buffer {
  if (png.width === width && png.height === height) return png.data;
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < png.height; y++) {
    png.data.copy(out, y * width * 4, y * png.width * 4, (y + 1) * png.width * 4);
  }
  return out;
}

export async function compareShot(
  outDir: string,
  file: string,
  baselineDir: string,
  baselineFile: string,
  thumbnailer: Thumbnailer
): Promise<Difference> {
  const current = PNG.sync.read(readFileSync(join(outDir, file)));
  const previous = PNG.sync.read(readFileSync(join(baselineDir, baselineFile)));
  const width = Math.max(current.width, previous.width);
  const height = Math.max(current.height, previous.height);
  const diff = new PNG({ width, height });
  const pixels = pixelmatch(padded(previous, width, height), padded(current, width, height), diff.data, width, height, {
    threshold: 0.1,
    alpha: 0.2
  });
  const sizeChanged = current.width !== previous.width || current.height !== previous.height;
  const ratio = pixels / (width * height);
  if (pixels === 0)
    return { baselineFile: null, baselineThumb: null, diffFile: null, diffThumb: null, pixels, ratio, sizeChanged };

  // Only what changed keeps its baseline and diff beside the report, each with a thumbnail for its card.
  const copied = join('baseline', baselineFile);
  mkdirSync(dirname(join(outDir, copied)), { recursive: true });
  copyFileSync(join(baselineDir, baselineFile), join(outDir, copied));
  const diffFile = join('diffs', file.replace(/^shots\//u, ''));
  mkdirSync(dirname(join(outDir, diffFile)), { recursive: true });
  writeFileSync(join(outDir, diffFile), PNG.sync.write(diff));
  return {
    baselineFile: copied,
    baselineThumb: await thumbnailer.make(outDir, copied),
    diffFile,
    diffThumb: await thumbnailer.make(outDir, diffFile),
    pixels,
    ratio,
    sizeChanged
  };
}
