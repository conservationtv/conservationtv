// Signs a commit off on this machine: `pnpm signoff [name…]` makes each report (src/reports.ts) and runs each signoff
// (src/signoffs.ts) at the checked-out commit, uploads what it found to the review tool, and gives the signoffs that
// passed with `gh signoff`, linking each status to its result there. With no names, every report and signoff runs.
//
//   pnpm signoff                    every signoff
//   pnpm signoff lint typecheck     some
//   pnpm signoff --no-upload        give them without uploading anything
//   pnpm signoff --no-signoff       run and upload, without giving any
//   REVIEW_URL=http://localhost:6423 pnpm signoff test   upload to a local review tool

import { spawn, spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { CALLS_FILE } from './calls.ts';
import { callsReport } from './report-calls.ts';
import { reports, type Report } from './reports.ts';
import { LOG_FILE, RESULT_FILE, type RunResult } from './results.ts';
import { signoffs, type Signoff } from './signoffs.ts';

const REVIEW_URL = process.env.REVIEW_URL ?? 'https://review.tools.conservation.tv';
// Escape sequences for colour and cursor movement: kept on the terminal, left out of the uploaded log.
// oxlint-disable-next-line no-control-regex -- ANSI escapes start with the escape character.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** A command's output, as text, failing loudly: these are git and gh, which the rest relies on. */
function output(command: string, args: readonly string[]): string {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

/** Files the commit has that the working tree changed, or that are new to it. */
function changedFiles(): string[] {
  return output('git', ['status', '--porcelain']).split('\n').filter(Boolean);
}

/** One command, streamed to the terminal as it runs and kept for the log; resolves with its exit code. */
function run(command: string, log: string[]): Promise<number> {
  log.push(`$ ${command}\n`);
  process.stdout.write(`\n\u001b[1m$ ${command}\u001b[0m\n`);
  return new Promise(resolve => {
    const child = spawn('sh', ['-c', command], {
      stdio: ['inherit', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? '1' }
    });
    const keep = (chunk: Buffer, to: NodeJS.WriteStream) => {
      to.write(chunk);
      log.push(chunk.toString('utf8').replace(ANSI, ''));
    };
    child.stdout.on('data', (chunk: Buffer) => keep(chunk, process.stdout));
    child.stderr.on('data', (chunk: Buffer) => keep(chunk, process.stderr));
    child.on('close', code => resolve(code ?? 1));
  });
}

interface Outcome {
  result: RunResult;
  log: string;
  /** Files a report wrote, by name, uploaded before its result. */
  files?: Record<string, string>;
  /** Why `gh signoff` would not give a run that passed. */
  refusal?: string | null;
}

/** Runs a signoff's commands in order, stopping at the first that fails; a run that changes files fails too. */
async function runSignoff(signoff: Signoff, sha: string): Promise<Outcome> {
  const started = Date.now();
  const log: string[] = [];
  let reason: string | null = null;
  for (const command of signoff.commands) {
    const code = await run(command, log);
    // The first failing command decides: the ones after it would only repeat or hide it.
    if (code !== 0) {
      reason = `\`${command}\` exited with ${code}.`;
      break;
    }
  }
  const changed = changedFiles();
  if (!reason && changed.length) {
    reason = `It changed ${changed.length} file${changed.length === 1 ? '' : 's'} the commit has.`;
    log.push(`\nChanged by this run:\n${changed.join('\n')}\n`);
  }
  const result: RunResult = {
    signoff: signoff.name,
    sha,
    state: reason ? 'failure' : 'success',
    reason,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    // The review tool sets this from the token it checked.
    ranBy: '',
    files: []
  };
  return { result, log: log.join('') };
}

/** Puts one file of a run in the review tool's results, as the GitHub user `gh` is signed in as. */
async function upload(token: string, sha: string, signoff: string, file: string, body: string): Promise<void> {
  const response = await fetch(`${REVIEW_URL}/api/results/${sha}/${signoff}/${file}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
    body
  });
  if (!response.ok) throw new Error(`Uploading ${file} answered ${response.status}: ${await response.text()}`);
}

/** Where a signoff's result is read in the review tool: what its commit status links to. */
function resultUrl(sha: string, signoff: string): string {
  return `${REVIEW_URL}/results/${sha}/${signoff}`;
}

interface Chosen {
  reports: Report[];
  signoffs: Signoff[];
}

/** The reports and signoffs named on the command line, in their own order; all of them when none are named. */
function chosen(names: readonly string[]): Chosen {
  const all = [...reports, ...signoffs].map(each => each.name);
  const unknown = names.filter(name => !all.includes(name));
  if (unknown.length) throw new Error(`Nothing is named ${unknown.join(', ')}. There are: ${all.join(', ')}.`);
  const named = <T extends Report | Signoff>(list: readonly T[]) =>
    names.length ? list.filter(each => names.includes(each.name)) : [...list];
  return { reports: named(reports), signoffs: named(signoffs) };
}

/** Where the pull request left its base branch: `gh` names the base, else it is main. */
function mergeBase(): string {
  const pull = spawnSync('gh', ['pr', 'view', '--json', 'baseRefName', '--jq', '.baseRefName'], { encoding: 'utf8' });
  const branch = pull.status === 0 && pull.stdout.trim() ? pull.stdout.trim() : 'main';
  return output('git', ['merge-base', `origin/${branch}`, 'HEAD']);
}

/** Makes a report: what it wrote, and a log that sums it up; failed only when it could not be made. */
async function makeReport(report: Report, sha: string): Promise<Outcome> {
  const started = Date.now();
  const result: RunResult = {
    signoff: report.name,
    sha,
    state: 'success',
    reason: null,
    startedAt: new Date(started).toISOString(),
    durationMs: 0,
    ranBy: '',
    files: []
  };
  try {
    const base = mergeBase();
    const calls = await callsReport(process.cwd(), sha, base);
    const log = `Against ${base.slice(0, 7)}: ${calls.units.length} changed units, ${calls.calls.length} uses.\n`;
    console.log(`\n${report.label}: ${log}`);
    return {
      result: { ...result, durationMs: Date.now() - started },
      log,
      files: { [CALLS_FILE]: JSON.stringify(calls) }
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { result: { ...result, state: 'failure', reason, durationMs: Date.now() - started }, log: `${reason}\n` };
  }
}

/** Uploads a run's log and then its result, which marks it complete; a failed upload is said, not fatal. */
async function share(token: string | null, outcome: Outcome): Promise<boolean> {
  const { result, log } = outcome;
  if (!token) return false;
  try {
    await upload(token, result.sha, result.signoff, LOG_FILE, log);
    for (const [file, body] of Object.entries(outcome.files ?? {})) {
      await upload(token, result.sha, result.signoff, file, body);
    }
    await upload(token, result.sha, result.signoff, RESULT_FILE, JSON.stringify(result));
    return true;
  } catch (error) {
    console.error(`\nCould not upload ${result.signoff}'s result: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

/** How a run is shared: uploaded with a token, and whether one that passed is given with `gh signoff`. */
interface Sharing {
  token: string | null;
  give: boolean;
}

/**
 * Gives a passed signoff with `gh signoff`, linked to its result when that was uploaded. `gh signoff` refuses a commit
 * that isn't pushed, or a tree with changes: said in the summary rather than ending the run.
 */
function give(signoff: Signoff, sha: string, shared: boolean): string | null {
  const url = shared ? ['--url', resultUrl(sha, signoff.name)] : [];
  const given = spawnSync('gh', ['signoff', signoff.name, '--commit', sha, ...url], { encoding: 'utf8' });
  return given.status === 0 ? null : `gh signoff refused: ${given.stderr.trim()}`;
}

/** Runs a signoff, shares its result, and gives it when it passed. */
async function signOff(signoff: Signoff, sha: string, sharing: Sharing): Promise<Outcome> {
  const outcome = await runSignoff(signoff, sha);
  const shared = await share(sharing.token, outcome);
  if (outcome.result.state === 'success' && sharing.give) outcome.refusal = give(signoff, sha, shared);
  return outcome;
}

/** A run in a line, for the summary at the end. */
function summary(signoff: Signoff | Report, { result, refusal }: Outcome): string {
  const seconds = Math.round(result.durationMs / 1000);
  const mark = result.state === 'success' ? '✓' : '✕';
  const why = result.reason ?? refusal;
  return `${mark} ${signoff.label} (${seconds}s)${why ? `: ${why}` : ''}`;
}

/**
 * Refuses a working tree with changes, as a signoff is of a commit; then runs each chosen signoff and sums them up,
 * failing when any did.
 */
async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'no-upload': { type: 'boolean', default: false },
      'no-signoff': { type: 'boolean', default: false }
    }
  });
  const choice = chosen(positionals);
  if (changedFiles().length) {
    console.error('The working tree has changes: commit or stash them, so the signoffs are of the commit.');
    return 1;
  }
  const sha = output('git', ['rev-parse', 'HEAD']);
  const sharing: Sharing = {
    token: values['no-upload'] ? null : output('gh', ['auth', 'token']),
    give: !values['no-signoff']
  };
  const lines: string[] = [];
  let failed = false;
  // Reports first: they read the commit and change nothing.
  for (const report of choice.reports) {
    const outcome = await makeReport(report, sha);
    await share(sharing.token, outcome);
    lines.push(summary(report, outcome));
  }
  for (const signoff of choice.signoffs) {
    // One at a time, in the listed order: a signoff that leaves the tree changed stops the rest, as they would no
    // longer be of the commit.
    const outcome = await signOff(signoff, sha, sharing);
    lines.push(summary(signoff, outcome));
    failed ||= outcome.result.state === 'failure';
    if (changedFiles().length) break;
  }
  console.log(`\nAt ${sha.slice(0, 7)}:\n${lines.join('\n')}`);
  if (sharing.token) console.log(`Results: ${REVIEW_URL}/results/${sha}`);
  return failed ? 1 : 0;
}

process.exitCode = await main().catch((error: Error) => {
  console.error(error.message);
  return 1;
});
