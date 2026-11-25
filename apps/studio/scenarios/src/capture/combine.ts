import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import type { ReportShot } from './report.ts';
import { readReport, writeReport } from './reports.ts';

// `merge`: one report from the shards of a run, each taken (and compared with its baseline) on a runner of its own.
// Their images are copied into one directory, and their shots put back in the run's order. Free of packages, so CI's
// last job runs it on Node alone.

/** What a shard's report directory holds beside report.json and index.html. */
const PARTS = ['shots', 'aria', 'thumbs', 'baseline', 'diffs'];

export function mergeCommand(args: string[]) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { out: { type: 'string' } } });
  if (!values.out || positionals.length === 0) throw new Error('Usage: merge --out <dir> <report dir>...');
  const out = resolve(values.out);
  mkdirSync(out, { recursive: true });
  const reports = positionals.map(dir => ({ dir: resolve(dir), data: readReport(resolve(dir)) }));
  for (const { dir } of reports) {
    for (const part of PARTS)
      if (existsSync(join(dir, part))) cpSync(join(dir, part), join(out, part), { recursive: true });
  }
  const [first] = reports;
  if (!first) return;
  const shots: ReportShot[] = reports.flatMap(report => report.data.shots).sort((a, b) => a.order - b.order);
  // Every shard was taken from the same run, so its scenarios are the first's. A shard whose base couldn't be taken has
  // no baseline; the merged report is compared if any shard was, its uncompared shots counting as new.
  const baseline = reports.map(report => report.data.baseline).find(found => found !== null) ?? null;
  writeReport(out, { ...first.data, baseline, shots, removed: reports.flatMap(report => report.data.removed) });
  console.log(`Merged ${reports.length} reports: ${shots.length} screenshots.`);
}
