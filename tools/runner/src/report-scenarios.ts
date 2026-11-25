import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync
} from 'node:fs';
import { availableParallelism, homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { ScenarioReportSchema, SCENARIOS_FILE, type ScenarioReport } from './scenarios.ts';
import { git } from './workspace.ts';

// The scenarios report: the studio web app screenshotted across generated worlds (apps/studio/scenarios), at the merge
// base and at the head, compared shot by shot, as `.github/workflows/scenarios.yml` did on Actions. Each side's web app
// is built in a worktree of its own commit with its own install, so a change to a shared package shows on the side it
// is on; both are captured against the head's worlds and mock API, so only the app differs. The base's build is kept
// by commit, as every pull request against it shares it. The report directory (report.json and its images) is what is
// uploaded; the review tool draws it from report.json.

const WEB = 'apps/studio/web';
const SCENARIOS = 'apps/studio/scenarios';
/** Built web apps, by commit: a merge base is built once for every pull request on it. */
const BUILDS = path.join(homedir(), '.cache', 'conservationtv', 'studio-web');
/** The merge base's screenshots, by the base and what they were captured with: reused until either changes. */
const BASE_SHOTS = path.join(homedir(), '.cache', 'conservationtv', 'studio-scenarios');
/** How long a cached build or base capture is kept unused. */
const KEEP_MS = 14 * 24 * 60 * 60 * 1000;
/**
 * What a capture runs on besides the web app being shot, all from the head: the worlds and capture code, the mock
 * API's contracts and health rules, the SDKs whose schemas check its answers, the packages they draw on, and the
 * lockfile. The base's shots are reused only while every one of these is as it was.
 */
const CAPTURED_WITH = [
  'apps/studio/scenarios',
  'apps/studio/api/contracts',
  'apps/studio/api/src/health',
  'apps/studio/sdk',
  'apps/agent/sdk',
  'packages/versioned-api',
  'packages/reports',
  'packages/shows',
  'packages/cameras',
  'pnpm-lock.yaml'
];
/** Pages captured at once: most of the machine's cores, from 4 to 12 (each is a browser page and its requests). */
const CONCURRENCY = Math.min(12, Math.max(4, availableParallelism() - 2));
/** Runs a command to completion, its output shown as it goes; fails with the command when it does. */
function run(command: string, args: readonly string[], cwd: string): void {
  const result = spawnSync(command, args, {
    cwd,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '1', CI: '1' }
  });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed in ${cwd}`);
}

/** A worktree of a commit with the packages `filters` name installed from its own lockfile. */
function installedWorktree(root: string, commit: string, filters: readonly string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'scenarios-'));
  git(root, ['worktree', 'add', '--detach', '--quiet', dir, commit]);
  const filterArgs = filters.flatMap(filter => ['--filter', filter]);
  run('pnpm', ['install', '--frozen-lockfile', '--prefer-offline', ...filterArgs], dir);
  return dir;
}

function removeWorktree(root: string, dir: string): void {
  spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: root });
}

/** Builds the web app's client bundle in a checkout, and keeps it under the commit's cache entry. */
function buildWeb(checkout: string, commit: string): string {
  run(path.join(checkout, WEB, 'node_modules', '.bin', 'react-router'), ['build'], path.join(checkout, WEB));
  const cached = path.join(BUILDS, commit);
  mkdirSync(BUILDS, { recursive: true });
  rmSync(cached, { recursive: true, force: true });
  cpSync(path.join(checkout, WEB, 'build', 'client'), cached, { recursive: true });
  return cached;
}

/** The base's built web app: from the cache when it was built before, else built in a worktree of its own. */
function baseBuild(root: string, base: string): string | null {
  const cached = path.join(BUILDS, base);
  if (existsSync(path.join(cached, 'index.html'))) {
    // Touched, so pruning keeps what is still used.
    const now = new Date();
    utimesSync(cached, now, now);
    return cached;
  }
  const dir = installedWorktree(root, base, ['@conservationtv/web...']);
  try {
    return buildWeb(dir, base);
  } catch (error) {
    // A base that won't build leaves the head's report uncompared, not missing.
    console.error(`The merge base's web app didn't build, so the shots won't be compared: ${String(error)}`);
    return null;
  } finally {
    removeWorktree(root, dir);
  }
}

/** How one side is captured: its build and commit, what it is captured with, and what it may take shots from. */
interface Side {
  web: string;
  commit: string;
  label: string;
  /** What the shots are captured with besides the web app (capturedWith): the same on both sides. */
  fingerprint: string;
  /** Earlier reports, directories or the review tool's addresses, to take unchanged pages' shots from. */
  reuse: string[];
}

/** Captures the shots of one side with the head's scenarios package, compared with a baseline report when given. */
function capture(head: string, side: Side, out: string, baseline: string | null): void {
  const args = [
    'src/cli.ts',
    'report',
    '--web',
    side.web,
    '--commit',
    side.commit,
    '--label',
    side.label,
    '--out',
    out
  ];
  args.push('--concurrency', String(CONCURRENCY), '--captured-with', side.fingerprint);
  for (const source of side.reuse) args.push('--reuse', source);
  if (baseline) args.push('--baseline', baseline);
  // A narrower run, for trying it: SCENARIOS_ARGS='--scenarios typical --random 0 --themes light'.
  args.push(...(process.env.SCENARIOS_ARGS?.split(/\s+/).filter(Boolean) ?? []));
  const scenarios = path.join(head, SCENARIOS);
  run(path.join(scenarios, 'node_modules', '.bin', 'tsx'), args, scenarios);
}

/** Removes cache entries no run has used in a while: builds and base captures pile up a commit at a time. */
function prune(dir: string): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const entry = path.join(dir, name);
    if (Date.now() - statSync(entry).mtimeMs > KEEP_MS) rmSync(entry, { recursive: true, force: true });
  }
}

/** The fingerprint of what the base's shots are captured with: each input's git object at the head, and the options. */
function capturedWith(root: string, sha: string): string {
  const objects = CAPTURED_WITH.map(entry =>
    spawnSync('git', ['rev-parse', `${sha}:${entry}`], { cwd: root, encoding: 'utf8' }).stdout.trim()
  );
  return createHash('sha256')
    .update([...objects, process.env.SCENARIOS_ARGS ?? ''].join('\n'))
    .digest('hex')
    .slice(0, 16);
}

/**
 * The merge base's screenshots, compared with nothing: from the cache when the base was captured with the same worlds
 * and options before, else captured into it. Null when they can't be taken, which leaves the head's uncompared.
 */
function baseShots(head: string, base: string, baseWeb: string, fingerprint: string, reviewUrl: string): string | null {
  const cached = path.join(BASE_SHOTS, `${base}-${fingerprint}`);
  if (existsSync(path.join(cached, SCENARIOS_FILE))) {
    console.log(`Reusing the merge base's screenshots from ${cached}.`);
    // Touched, so pruning keeps what is still used.
    const now = new Date();
    utimesSync(cached, now, now);
    return cached;
  }
  mkdirSync(BASE_SHOTS, { recursive: true });
  const taking = `${cached}.taking`;
  rmSync(taking, { recursive: true, force: true });
  try {
    // Shots someone has already uploaded of a build like this one's, rather than captured here.
    const reuse = uploadsOf(head, base, reviewUrl);
    capture(head, { web: baseWeb, commit: base, label: 'base', fingerprint, reuse }, taking, null);
    renameSync(taking, cached);
    return cached;
  } catch (error) {
    console.error(`The merge base's shots failed, so the head's won't be compared: ${String(error)}`);
    rmSync(taking, { recursive: true, force: true });
    return null;
  }
}

/** Every file under a directory, as paths relative to it. */
export function filesUnder(dir: string, prefix = ''): string[] {
  return readdirSync(dir).flatMap(name => {
    const relative = prefix ? `${prefix}/${name}` : name;
    return statSync(path.join(dir, name)).isDirectory() ? filesUnder(path.join(dir, name), relative) : [relative];
  });
}

/** A report made: what to log, and the directory whose files are uploaded. */
export interface ScenariosMade {
  log: string;
  dir: string;
  report: ScenarioReport;
}

/** The report's run in a line: how many shots, how many changed, how many have issues. */
function summaryOf(report: ScenarioReport, compared: boolean): string {
  const changed = report.shots.filter(shot => (shot.difference?.ratio ?? 0) > 0).length;
  const issues = report.shots.filter(shot => shot.issues.length > 0).length;
  const comparison = compared ? `${changed} changed from the merge base` : 'not compared: the merge base did not build';
  return `${report.shots.length} shots of ${report.scenarios.length} scenarios, ${comparison}, ${issues} with issues.\n`;
}

/** Where the review tool serves a commit's scenarios report from. */
function uploadedAt(reviewUrl: string, commit: string): string {
  return `${reviewUrl}/api/results/${commit}/scenarios`;
}

/**
 * Uploaded reports worth taking a commit's shots from: the commit's own, and those of the pull requests merged as it
 * (the head a merge commit was made of, signed off before it merged). Whatever they offer is checked page by page.
 */
function uploadsOf(head: string, commit: string, reviewUrl: string): string[] {
  const pulls = spawnSync('gh', ['api', `repos/{owner}/{repo}/commits/${commit}/pulls`, '--jq', '.[].head.sha'], {
    cwd: head,
    encoding: 'utf8'
  });
  const heads = pulls.status === 0 ? pulls.stdout.split('\n').filter(Boolean) : [];
  return [commit, ...heads].map(each => uploadedAt(reviewUrl, each));
}

/** The scenarios report of `sha` against `base`, in a directory of its own; the caller removes it after uploading. */
export function scenariosReport(root: string, sha: string, base: string, reviewUrl: string): ScenariosMade {
  const out = mkdtempSync(path.join(tmpdir(), 'scenarios-report-'));
  const head = installedWorktree(root, sha, ['@conservationtv/web...', '@conservationtv/studio-scenarios...']);
  try {
    // The shell Playwright drives: installed once per machine, skipped when it already is.
    run(
      path.join(head, SCENARIOS, 'node_modules', '.bin', 'playwright'),
      ['install', '--only-shell', 'chromium'],
      head
    );
    prune(BUILDS);
    prune(BASE_SHOTS);
    const headWeb = buildWeb(head, sha);
    const baseWeb = baseBuild(root, base);
    const fingerprint = capturedWith(root, sha);
    const baseline = baseWeb ? baseShots(head, base, baseWeb, fingerprint, reviewUrl) : null;
    // Unchanged pages' shots from the base, else from an upload of this same commit (a run again, say).
    const reuse = [...(baseline ? [baseline] : []), uploadedAt(reviewUrl, sha)];
    capture(head, { web: headWeb, commit: sha, label: 'head', fingerprint, reuse }, path.join(out, 'report'), baseline);
    const dir = path.join(out, 'report');
    const report = ScenarioReportSchema.parse(JSON.parse(readFileSync(path.join(dir, SCENARIOS_FILE), 'utf8')));
    return { log: summaryOf(report, baseline !== null), dir, report };
  } finally {
    removeWorktree(root, head);
  }
}
