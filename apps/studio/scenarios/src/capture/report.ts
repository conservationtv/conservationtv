import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium, type Browser } from 'playwright';

import { DEFAULT_WEB_ROOT, startServer } from '../serve.ts';
import { findScenario, NAMED_SCENARIOS, worldOf, type Scenario } from '../world/scenarios.ts';
import type { Fault } from '../world/spec.ts';
import { capture, VIEWPORTS, type CaptureTask, type Shot, type Theme, type Viewport } from './capture.ts';
import { compareShot, type Difference } from './compare.ts';
import { renderReport } from './html.ts';
import { Thumbnailer } from './thumbnails.ts';
import { pagesOf, type Page } from './pages.ts';

// `report`: screenshot every page of every chosen scenario's world, in each theme and viewport, against the web app's
// production build and the mock API, into a directory holding the images, report.json and index.html. Given a
// baseline (an earlier report: run one on main, then on a branch with `--baseline main`), each shot is compared with
// the baseline's and the report leads with what changed most.

const REPORTS_DIR = fileURLToPath(new URL('../../reports/', import.meta.url));
const WEB_DIR = fileURLToPath(new URL('../../../web/', import.meta.url));

const HELP = `Usage: pnpm --filter @conservationtv/studio-scenarios report [options]

  --scenarios <ids>    Comma-separated scenario IDs (default: every named one). random-<n> works too.
  --random <n>         Also capture random-1 … random-<n> (default 6; 0 for none).
  --pages <ids>        Only these pages, by ID or prefix: streams,outputs/detail (default: every page).
  --themes <list>      light,dark (default both).
  --viewports <list>   desktop,mobile (default desktop).
  --label <name>       Names the report: written to reports/<label> (default: the current branch).
  --out <dir>          Write here instead.
  --baseline <dir>     Compare with an earlier report: a directory, or a label under reports/.
  --web <dir>          The built web app to serve (default: apps/studio/web/build/client).
  --build              Build the web app first (it is built anyway when there is no build).
  --concurrency <n>    Pages captured at once (default 4).
  --settle <ms>        How long a page may take to go quiet before it is captured anyway (default 10000).
  --port <n>           Port for the mock API and web app (default 6439).
  --shard <i>/<n>      Take only the i-th of n even slices of the shots (CI captures them on n runners at once).
  --commit <sha>       The commit the web build is of, when it isn't this checkout's (CI captures the base's build).`;

interface Options {
  scenarios: Scenario[];
  pages: string[];
  themes: Theme[];
  viewports: Viewport[];
  out: string;
  label: string;
  baseline: string | null;
  web: string;
  build: boolean;
  concurrency: number;
  settle: number;
  port: number;
  commit: string | undefined;
  shard: Shard;
}

/** One of `count` slices of the shots, numbered from 1. */
interface Shard {
  index: number;
  count: number;
}

/** `--shard 2/8` as a shard: the whole run when not given, refused unless 1 ≤ i ≤ n. */
function shardOf(value: string | undefined): Shard {
  if (!value) return { index: 1, count: 1 };
  const [index, count] = value.split('/').map(Number);
  if (!index || !count || index > count) throw new Error(`--shard takes <i>/<n>, such as 2/8, not ${value}`);
  return { index, count };
}

export interface ReportScenario {
  id: string;
  title: string;
  description: string;
  incidents: string[];
  counts: Record<string, number>;
  faults: string[];
}

export interface ReportShot extends Shot {
  /** Where the shot comes among all of the run's, across shards: what merged reports are put back in order by. */
  order: number;
  difference: Difference | null;
  /** Problems found on the page, in words. */
  issues: string[];
  /** What the scenario meant to happen, such as the error boundary an injected fault shows. Not counted as issues. */
  expected: string[];
}

/** The commit a report was taken at. */
export interface GitState {
  branch: string;
  commit: string;
  dirty: boolean;
}

/** The report a run was compared with. */
export interface BaselineReference {
  label: string;
  commit: string;
}

/** How the shots were taken, as far as reading the report goes. */
export interface ReportOptions {
  themes: Theme[];
  viewports: Viewport[];
  pages: string[];
}

export interface ReportData {
  label: string;
  createdAt: string;
  git: GitState;
  baseline: BaselineReference | null;
  options: ReportOptions;
  scenarios: ReportScenario[];
  shots: ReportShot[];
  /** Shots the baseline had that this run didn't take. */
  removed: string[];
}

function git(...args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
}

const THEMES: readonly string[] = ['light', 'dark'] satisfies Theme[];

function isTheme(value: string): value is Theme {
  return THEMES.includes(value);
}

function isViewport(value: string): value is Viewport {
  return Object.hasOwn(VIEWPORTS, value);
}

/** The items of a comma-separated list, each checked to be one of the kind wanted. */
function listOf<T extends string>(value: string | undefined, what: string, is: (item: string) => item is T): T[] {
  return list(value).map(item => {
    if (!is(item)) throw new Error(`No ${what} ${item}`);
    return item;
  });
}

/** The scenarios asked for, or every named one and the first `random` random ones. */
function scenariosOf(asked: string | undefined, random: number): Scenario[] {
  const ids = asked ? list(asked) : NAMED_SCENARIOS.map(scenario => scenario.id);
  for (let n = 1; n <= random; n++) if (!asked) ids.push(`random-${n}`);
  return ids.map(id => {
    const scenario = findScenario(id);
    if (!scenario) throw new Error(`No scenario ${id}`);
    return scenario;
  });
}

/** The baseline's directory: a path to one, or a label under reports/. It must hold a report, and not be this one. */
function baselineDirOf(baseline: string | undefined, out: string): string | null {
  if (!baseline) return null;
  const dir = isAbsolute(baseline) || existsSync(baseline) ? resolve(baseline) : join(REPORTS_DIR, baseline);
  if (!existsSync(join(dir, 'report.json'))) throw new Error(`No report at ${dir} to compare with`);
  if (dir === out) throw new Error('The baseline is the report being written: give this run another --label');
  return dir;
}

const OPTIONS = {
  help: { type: 'boolean' },
  scenarios: { type: 'string' },
  random: { type: 'string', default: '6' },
  pages: { type: 'string' },
  themes: { type: 'string', default: 'light,dark' },
  viewports: { type: 'string', default: 'desktop' },
  label: { type: 'string' },
  out: { type: 'string' },
  baseline: { type: 'string' },
  web: { type: 'string', default: DEFAULT_WEB_ROOT },
  build: { type: 'boolean', default: false },
  concurrency: { type: 'string', default: '4' },
  settle: { type: 'string', default: '10000' },
  port: { type: 'string', default: '6439' },
  commit: { type: 'string' },
  shard: { type: 'string' }
} as const;

/** The options, or undefined after printing the help. A report is written to reports/<label> unless --out says. */
function parse(args: string[]): Options | undefined {
  const { values } = parseArgs({ args, options: OPTIONS });
  if (values.help) {
    console.log(HELP);
    return undefined;
  }
  const label = (values.label ?? (git('rev-parse', '--abbrev-ref', 'HEAD') || 'report')).replace(
    /[^A-Za-z0-9._-]+/gu,
    '-'
  );
  const out = resolve(values.out ?? join(REPORTS_DIR, label));
  return {
    scenarios: scenariosOf(values.scenarios, Number(values.random)),
    pages: list(values.pages),
    themes: listOf(values.themes, 'theme', isTheme),
    viewports: listOf(values.viewports, 'viewport', isViewport),
    out,
    label,
    baseline: baselineDirOf(values.baseline, out),
    web: resolve(values.web),
    build: values.build,
    concurrency: Math.max(1, Number(values.concurrency)),
    settle: Number(values.settle),
    port: Number(values.port),
    commit: values.commit?.slice(0, 8),
    shard: shardOf(values.shard)
  };
}

/** Empties the report directory, refusing one that holds anything but an earlier report. */
function prepareOut(out: string) {
  if (existsSync(out)) {
    if (!existsSync(join(out, 'report.json'))) {
      const entries = spawnSync('ls', ['-A', out], { encoding: 'utf8' }).stdout.trim();
      if (entries) throw new Error(`${out} isn't empty and isn't a report; choose another --out`);
    }
    for (const part of ['shots', 'aria', 'thumbs', 'diffs', 'baseline', 'index.html', 'report.json'])
      rmSync(join(out, part), { recursive: true, force: true });
  }
  mkdirSync(out, { recursive: true });
}

/** `3 console errors`, `1 console error`. */
function counted(count: number, noun: string): string {
  return `${count} ${noun}${count > 1 ? 's' : ''}`;
}

/** Problems found on a page, in words. */
/** Whether the scenario injects failures: then error boundaries are what it is for. */
function injectsFailures(shot: Shot): boolean {
  const faults = findScenario(shot.scenario)?.spec.faults ?? {};
  return Object.values(faults).some(fault => fault.status !== undefined);
}

function expectedOf(shot: Shot): string[] {
  return shot.errorBoundary && injectsFailures(shot) ? ['Error boundary (injected fault)'] : [];
}

function issuesOf(shot: Shot): string[] {
  const contract = shot.ledger.filter(entry => entry.kind === 'contract').length;
  const unmocked = shot.ledger.filter(entry => entry.kind === 'unmocked').length;
  const found: [boolean, string][] = [
    [shot.errorBoundary && !injectsFailures(shot), 'Error boundary shown'],
    [shot.pageErrors.length > 0, counted(shot.pageErrors.length, 'uncaught error')],
    [shot.consoleErrors.length > 0, counted(shot.consoleErrors.length, 'console error')],
    [shot.apiFailures.length > 0, counted(shot.apiFailures.length, 'failed API call')],
    [contract > 0, `${counted(contract, 'contract violation')} in the mock`],
    [unmocked > 0, counted(unmocked, 'unmocked call')],
    [shot.overflow, 'Scrolls sideways'],
    [!shot.settled, 'Never settled']
  ];
  return found.filter(([present]) => present).map(([, issue]) => issue);
}

/** A fault in words: `organisations.topology.get: answers 503`. */
function faultText(operation: string, fault: Fault): string {
  if (fault.hang) return `${operation}: never answers`;
  if (fault.status) return `${operation}: answers ${fault.status}`;
  return `${operation}: ${fault.delayMs} ms late`;
}

function summarise(scenario: Scenario): ReportScenario {
  const world = worldOf(scenario);
  return {
    id: scenario.id,
    title: scenario.title,
    description: scenario.description,
    incidents: world.incidents.map(incident => incident.summary),
    counts: {
      networks: world.networks.length,
      agents: world.agents.length,
      cameras: world.cameras.length,
      streams: world.streams.length,
      shows: world.shows.length,
      outputs: world.outputs.length,
      channels: world.channels.length,
      members: world.members.length
    },
    faults: Object.entries(scenario.spec.faults).map(([operation, fault]) => faultText(operation, fault))
  };
}

/** Build the web app when asked to, or when there's no build to serve; only the default build can be built here. */
function ensureBuild(options: Options) {
  if (!options.build && existsSync(join(options.web, '__spa-fallback.html'))) return;
  if (options.web !== resolve(DEFAULT_WEB_ROOT)) throw new Error(`No web build at ${options.web}`);
  console.log('Building the web app…');
  const built = spawnSync('pnpm', ['--filter', '@conservationtv/web', 'build'], { cwd: WEB_DIR, stdio: 'inherit' });
  if (built.status !== 0) throw new Error('The web app failed to build');
}

/** Whether a page is one of those asked for, by ID or by an ID it is beneath. */
function wanted(options: Options, page: Page): boolean {
  return options.pages.length === 0 || options.pages.some(id => page.id === id || page.id.startsWith(`${id}/`));
}

/** Every shot to take: each scenario's pages, at each viewport, in each theme. */
function tasksOf(options: Options): CaptureTask[] {
  const tasks: CaptureTask[] = [];
  for (const scenario of options.scenarios) {
    for (const page of pagesOf(worldOf(scenario)).filter(page => wanted(options, page)))
      for (const viewport of options.viewports)
        for (const theme of options.themes) tasks.push({ scenario, page, theme, viewport });
  }
  return tasks;
}

/** This shard's slice: every n-th shot from the i-th, so each gets a share of every scenario and of the slow pages. */
function inShard(options: Options, tasks: CaptureTask[]): CaptureTask[] {
  const { index, count } = options.shard;
  return tasks.filter((_task, at) => at % count === index - 1);
}

/** Take every shot, a few at once, against the mock API and the built web app, printing each as it lands. */
async function captureAll(options: Options, tasks: CaptureTask[], browser: Browser): Promise<Shot[]> {
  const served = await startServer(options.web, options.port);
  console.log(`Capturing ${tasks.length} screenshots of ${options.scenarios.length} scenarios into ${options.out}`);
  const shots: Shot[] = [];
  let next = 0;
  const worker = async () => {
    const thumbnailer = await Thumbnailer.open(browser);
    while (next < tasks.length) {
      const task = tasks[next++]!;
      const shot = await capture(browser, served.origin, options.out, task, options.settle, thumbnailer);
      shots.push(shot);
      const issues = issuesOf(shot);
      const mark = issues.length ? `  ⚠ ${issues.join(', ')}` : '';
      const progress = `[${String(shots.length).padStart(String(tasks.length).length)}/${tasks.length}]`;
      console.log(`${progress} ${shot.key} ${(shot.durationMs / 1000).toFixed(1)}s${mark}`);
    }
    await thumbnailer.close();
  };
  try {
    await Promise.all(Array.from({ length: options.concurrency }, worker));
  } finally {
    await served.close();
  }
  return shots;
}

function readBaseline(dir: string | null): ReportData | null {
  if (!dir) return null;
  const baseline: ReportData = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
  return baseline;
}

/** The shots in the order they were asked for, each with its issues and, given a baseline, how it changed. */
async function reportShotsOf(
  options: Options,
  tasks: CaptureTask[],
  shots: Shot[],
  baseline: ReportData | null,
  thumbnailer: Thumbnailer
): Promise<ReportShot[]> {
  const baselineShots = new Map((baseline?.shots ?? []).map(shot => [shot.key, shot]));
  const order = new Map(
    tasks.map((task, index) => [`${task.scenario.id}/${task.page.id}/${task.theme}-${task.viewport}`, index])
  );
  const sorted = shots.sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
  const reportShots: ReportShot[] = [];
  for (const shot of sorted) {
    const baselineShot = baselineShots.get(shot.key);
    const difference =
      baselineShot && options.baseline
        ? await compareShot(options.out, shot, options.baseline, baselineShot, thumbnailer)
        : null;
    const at = order.get(shot.key) ?? 0;
    reportShots.push({ ...shot, order: at, difference, issues: issuesOf(shot), expected: expectedOf(shot) });
  }
  return reportShots;
}

/** Every shot, then each compared with the baseline, in one browser that also makes their thumbnails. */
async function captureAndCompare(options: Options, all: CaptureTask[], baseline: ReportData | null) {
  const browser = await chromium.launch();
  try {
    const shots = await captureAll(options, inShard(options, all), browser);
    const thumbnailer = await Thumbnailer.open(browser);
    // Ordered among all the run's shots, not just this shard's, so shards merge back in order.
    const reportShots = await reportShotsOf(options, all, shots, baseline, thumbnailer);
    return { shots, reportShots };
  } finally {
    await browser.close();
  }
}

/** The report command: build if need be, take every shot, compare with the baseline if given, and write it all out. */
export async function report(args: string[]) {
  const options = parse(args);
  if (!options) return;
  ensureBuild(options);
  const tasks = tasksOf(options);
  prepareOut(options.out);
  const started = Date.now();
  const baseline = readBaseline(options.baseline);
  const { shots, reportShots } = await captureAndCompare(options, tasks, baseline);
  const taken = new Set(shots.map(shot => shot.key));
  const data: ReportData = {
    label: options.label,
    createdAt: new Date().toISOString(),
    git: {
      branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
      commit: options.commit ?? git('rev-parse', '--short', 'HEAD'),
      dirty: git('status', '--porcelain') !== ''
    },
    baseline: baseline ? { label: baseline.label, commit: baseline.git.commit } : null,
    options: { themes: options.themes, viewports: options.viewports, pages: options.pages },
    scenarios: options.scenarios.map(summarise),
    shots: reportShots,
    removed: baseline ? baseline.shots.map(shot => shot.key).filter(key => !taken.has(key)) : []
  };
  writeFileSync(join(options.out, 'report.json'), JSON.stringify(data, null, 2));
  writeFileSync(join(options.out, 'index.html'), renderReport(data));

  const withIssues = reportShots.filter(shot => shot.issues.length).length;
  const changed = reportShots.filter(shot => shot.difference && shot.difference.pixels > 0).length;
  const comparison = baseline ? `; ${changed} changed from ${baseline.label}` : '';
  console.log(
    `\n${reportShots.length} screenshots in ${((Date.now() - started) / 1000).toFixed(0)}s; ${withIssues} with issues${comparison}.`
  );
  console.log(`Report: ${join(options.out, 'index.html')}`);
}
