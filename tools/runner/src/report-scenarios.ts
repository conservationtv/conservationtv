import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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
  if (existsSync(path.join(cached, 'index.html'))) return cached;
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

/** Captures the shots of one side with the head's scenarios package, compared with a baseline report when given. */
function capture(head: string, web: string, commit: string, label: string, out: string, baseline: string | null): void {
  const args = ['src/cli.ts', 'report', '--web', web, '--commit', commit, '--label', label, '--out', out];
  if (baseline) args.push('--baseline', baseline);
  // A narrower run, for trying it: SCENARIOS_ARGS='--scenarios typical --random 0 --themes light'.
  args.push(...(process.env.SCENARIOS_ARGS?.split(/\s+/).filter(Boolean) ?? []));
  const scenarios = path.join(head, SCENARIOS);
  run(path.join(scenarios, 'node_modules', '.bin', 'tsx'), args, scenarios);
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

/** The scenarios report of `sha` against `base`, in a directory of its own; the caller removes it after uploading. */
export function scenariosReport(root: string, sha: string, base: string): ScenariosMade {
  const out = mkdtempSync(path.join(tmpdir(), 'scenarios-report-'));
  const head = installedWorktree(root, sha, ['@conservationtv/web...', '@conservationtv/studio-scenarios...']);
  try {
    // The shell Playwright drives: installed once per machine, skipped when it already is.
    run(
      path.join(head, SCENARIOS, 'node_modules', '.bin', 'playwright'),
      ['install', '--only-shell', 'chromium'],
      head
    );
    const headWeb = buildWeb(head, sha);
    const baseWeb = baseBuild(root, base);
    let baseline: string | null = null;
    if (baseWeb) {
      baseline = path.join(out, '..', `${path.basename(out)}-base`);
      try {
        capture(head, baseWeb, base, 'base', baseline, null);
      } catch (error) {
        console.error(`The merge base's shots failed, so the head's won't be compared: ${String(error)}`);
        baseline = null;
      }
    }
    capture(head, headWeb, sha, 'head', path.join(out, 'report'), baseline);
    if (baseline) rmSync(baseline, { recursive: true, force: true });
    const dir = path.join(out, 'report');
    const report = ScenarioReportSchema.parse(JSON.parse(readFileSync(path.join(dir, SCENARIOS_FILE), 'utf8')));
    return { log: summaryOf(report, baseline !== null), dir, report };
  } finally {
    removeWorktree(root, head);
  }
}
