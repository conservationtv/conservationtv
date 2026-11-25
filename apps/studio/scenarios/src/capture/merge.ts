import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

import { compareShot } from './compare.ts';
import type { ReportShot } from './report.ts';
import { readReport, writeReport } from './reports.ts';
import { Thumbnailer } from './thumbnails.ts';

// `compare`: sets a report beside a baseline taken separately, in place: every shot compared with the baseline's.

/** `compare <report> --baseline <report>`: compares every shot of a report with the baseline's, in place. */
export async function compareCommand(args: string[]) {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: { baseline: { type: 'string' } }
  });
  const [current] = positionals;
  if (!current || !values.baseline) throw new Error('Usage: compare <report dir> --baseline <report dir>');
  const dir = resolve(current);
  const baselineDir = resolve(values.baseline);
  const data = readReport(dir);
  const baseline = readReport(baselineDir);
  // What an earlier comparison left beside the report.
  for (const part of ['baseline', 'diffs', join('thumbs', 'baseline'), join('thumbs', 'diffs')]) {
    rmSync(join(dir, part), { recursive: true, force: true });
  }

  const baselineShots = new Map(baseline.shots.map(shot => [shot.key, shot]));
  const browser = await chromium.launch();
  const shots: ReportShot[] = [];
  try {
    const thumbnailer = await Thumbnailer.open(browser);
    for (const shot of data.shots) {
      const baselineShot = baselineShots.get(shot.key);
      const difference = baselineShot ? await compareShot(dir, shot, baselineDir, baselineShot, thumbnailer) : null;
      shots.push({ ...shot, difference });
    }
  } finally {
    await browser.close();
  }
  const taken = new Set(shots.map(shot => shot.key));
  writeReport(dir, {
    ...data,
    shots,
    baseline: { label: baseline.label, commit: baseline.git.commit },
    removed: baseline.shots.map(shot => shot.key).filter(key => !taken.has(key))
  });
  const changed = shots.filter(shot => shot.difference && shot.difference.pixels > 0).length;
  console.log(`${changed} of ${shots.length} screenshots changed from ${baseline.label}.`);
}
