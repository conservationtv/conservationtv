import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderReport } from './html.ts';
import type { ReportData } from './report.ts';

// Reading and writing a report directory's report.json and index.html. Free of packages, like everything CI's last
// job runs (src/ci.ts), so it runs on Node alone.

export function readReport(dir: string): ReportData {
  const data: ReportData = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
  return data;
}

export function writeReport(dir: string, data: ReportData) {
  writeFileSync(join(dir, 'report.json'), JSON.stringify(data, null, 2));
  writeFileSync(join(dir, 'index.html'), renderReport(data));
}
