import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import type { ReportData, ReportShot } from './report.ts';
import { readReport } from './reports.ts';

// `summary`: a report written up as Markdown for a pull request's comment, what changed most and what has issues
// first, each linking into the report where it is hosted. Free of packages, so CI's last job runs it on Node alone.

/** A share as a percentage, readable at the sizes changes come in. */
function percent(ratio: number): string {
  if (ratio < 0.0001) return '<0.01%';
  return `${(ratio * 100).toFixed(ratio < 0.01 ? 2 : 1)}%`;
}

/** Markdown's table cells: no pipes or line breaks. */
function cell(text: string): string {
  return text.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

const LISTED = 12;

/** What the summary reads from a report: its shots sorted into what changed, what is new and what has issues. */
interface Summary {
  data: ReportData;
  url: string | undefined;
  titles: Map<string, string>;
  changed: ReportShot[];
  added: ReportShot[];
  withIssues: ReportShot[];
}

const changeOf = (shot: ReportShot): number => shot.difference?.ratio ?? 0;
const hasChanged = (shot: ReportShot): boolean => (shot.difference?.pixels ?? 0) > 0;

function summaryOf(data: ReportData, url: string | undefined): Summary {
  return {
    data,
    url,
    titles: new Map(data.scenarios.map(scenario => [scenario.id, scenario.title])),
    changed: data.shots.filter(hasChanged).sort((a, b) => changeOf(b) - changeOf(a)),
    added: data.baseline ? data.shots.filter(shot => !shot.difference) : [],
    withIssues: data.shots.filter(shot => shot.issues.length > 0)
  };
}

/** The counts in a line, then the link to the report. */
function headline(summary: Summary): string[] {
  const { data, changed, added, withIssues, url } = summary;
  const facts = [`${data.shots.length} screenshots of ${data.scenarios.length} scenarios`];
  if (data.baseline) facts.push(`**${changed.length} changed** from ${data.baseline.label} (${data.baseline.commit})`);
  facts.push(`**${withIssues.length} with issues**`);
  if (added.length) facts.push(`${added.length} new`);
  if (data.removed.length) facts.push(`${data.removed.length} gone`);
  return [facts.join(' · '), ...(url ? ['', `**[Open the report](${url})**`] : [])];
}

/** A table of the first shots, with a first column of `first`, and a line for any more. */
function table(summary: Summary, heading: string, shots: ReportShot[], first: (shot: ReportShot) => string): string[] {
  if (!shots.length) return [];
  const rows = shots.slice(0, LISTED).map(shot => {
    const scenario = cell(summary.titles.get(shot.scenario) ?? shot.scenario);
    const page = summary.url
      ? `[${cell(shot.pageTitle)}](${summary.url}#shot=${encodeURIComponent(shot.key)})`
      : cell(shot.pageTitle);
    return `| ${cell(first(shot))} | ${scenario} | ${page} | ${shot.theme} |`;
  });
  const more = shots.length > LISTED ? ['', `…and ${shots.length - LISTED} more in the report.`] : [];
  return ['', `| ${heading} | Scenario | Page | Theme |`, '| --- | --- | --- | --- |', ...rows, ...more];
}

function changeText(shot: ReportShot): string {
  return percent(changeOf(shot)) + (shot.difference?.sizeChanged ? ', resized' : '');
}

/** `summary <report> [--url <hosted index.html>]`: the report as Markdown, most changed and issues first. */
export function summaryCommand(args: string[]) {
  const { positionals, values } = parseArgs({ args, allowPositionals: true, options: { url: { type: 'string' } } });
  const [dir] = positionals;
  if (!dir) throw new Error('Usage: summary <report dir> [--url <hosted index.html>]');
  const summary = summaryOf(readReport(resolve(dir)), values.url);
  const quiet = !summary.changed.length && !summary.withIssues.length;
  const lines = [
    '### Scenario screenshots',
    '',
    ...headline(summary),
    ...table(summary, 'Changed', summary.changed, changeText),
    ...table(summary, 'Issues', summary.withIssues, shot => shot.issues.join(', ')),
    ...(quiet ? ['', 'Nothing changed, and no page had issues.'] : [])
  ];
  console.log(lines.join('\n'));
}
