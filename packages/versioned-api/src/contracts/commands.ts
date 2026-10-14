import { appendFileSync, constants, copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { releaseName, type ContractsProject } from './config.js';
import { generateBundle } from './openapi.js';
import {
  checkReleasedContracts,
  checkSnapshotFiles,
  compatibilityChanges,
  readBundleAt,
  readCurrent,
  readReleases,
  type ReleaseDocument
} from './release.js';
import { snapshotStatus } from './snapshot-status.js';

/** Regenerate first; freeze a complete release bundle and never overwrite an existing snapshot. */
export async function snapshot(project: ContractsProject, tag: string | undefined): Promise<void> {
  const name = releaseName(project, tag);
  checkSnapshotFiles(project);
  await generateBundle(project);
  checkReleasedContracts(project, readCurrent(project));
  mkdirSync(project.snapshots, { recursive: true });
  const file = join(project.snapshots, `${name}.json`);
  copyFileSync(project.document, file, constants.COPYFILE_EXCL);
  console.log(`Wrote ${relative(project.dir, file)}. Commit it in the release PR, then tag that commit ${name}.`);
}

export interface CheckReleaseOptions {
  base?: string;
  tag?: string;
}

export function checkRelease(project: ContractsProject, options: CheckReleaseOptions): void {
  checkSnapshotFiles(project, options.base ?? 'HEAD');
  const current = readFileSync(project.document);
  checkReleasedContracts(project, readCurrent(project));
  if (options.tag !== undefined) {
    const name = releaseName(project, options.tag);
    const frozen = readFileSync(join(project.snapshots, `${name}.json`));
    if (!current.equals(frozen)) throw new Error(`${name}: committed snapshot differs from openapi.json`);
  }
  console.log('Release contracts and snapshot immutability checked.');
}

/** Gate: success means matching. Predicate (`required`): success means a snapshot is required. */
export function checkSnapshot(project: ContractsProject, required: boolean): number {
  const status = snapshotStatus(project);
  console.log(JSON.stringify(status));
  const success = required ? status.required : !status.required;
  return success ? 0 : 1;
}

const ModeSchema = z.enum(['pr', 'main', 'release', 'snapshots']);
export type Mode = z.output<typeof ModeSchema>;

export interface CiEnvironment {
  baseRef?: string;
  releaseTag?: string;
  githubActions: boolean;
  stepSummary?: string;
}

/** GitHub annotations use escaped newlines and percent signs; ordinary local runs print the same readable message. */
function report(env: CiEnvironment, message: string, warning = false): void {
  console.log(message);
  if (env.githubActions && warning) {
    const escaped = message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    console.log(`::warning title=API contracts::${escaped}`);
  }
  if (env.stepSummary) appendFileSync(env.stepSummary, `- ${message}\n`);
}

/** Compare both the PR base and released history, so removing a snapshot cannot hide a published contract. */
function warnCompatibility(
  project: ContractsProject,
  env: CiEnvironment,
  current: ReleaseDocument,
  base: string | undefined
) {
  if (!base) throw new Error('PR compatibility requires API_BASE_REF');
  const baselines = [{ name: 'PR base', document: readBundleAt(project, base) }, ...readReleases(project)];
  const warnings = new Map<string, string>();
  for (const baseline of baselines) {
    // Deduplicate historical changes while reporting retirement only against the PR base.
    for (const change of compatibilityChanges(baseline.document, current)) {
      // Only newly removed contracts warn; an intentionally retired historical version should not warn on every PR.
      if (change.kind === 'removed' && baseline.name !== 'PR base') continue;
      warnings.set(
        `${change.operation}:${change.kind}`,
        `${change.operation}: ${change.kind} relative to ${baseline.name}. ${
          change.kind === 'changed'
            ? 'Potentially incompatible: preserve the existing contract and declare a new operation version before snapshotting.'
            : 'Clients requiring this version will no longer be supported by this server.'
        }`
      );
    }
  }
  for (const message of warnings.values()) report(env, message, true);
  if (!warnings.size) report(env, 'No changed or removed versioned contracts detected.');
}

/** Drift is advisory on main; an API release must pass both frozen-history and exact snapshot checks. */
function releaseGate(project: ContractsProject, env: CiEnvironment, current: ReleaseDocument): void {
  const tag = releaseName(project, env.releaseTag);
  checkSnapshotFiles(project);
  checkReleasedContracts(project, current);
  const status = snapshotStatus(project);
  if (status.required) throw new Error(`Release blocked: snapshot required (${status.reason}).`);
  if (status.latest !== tag) throw new Error(`Release blocked: ${tag} is not the latest snapshot (${status.latest}).`);
  report(env, `${tag} is snapshot ready; frozen contracts and exact snapshot equality passed.`);
}

export function ci(project: ContractsProject, modeArgument: string | undefined, env: CiEnvironment): void {
  const mode: Mode = ModeSchema.parse(modeArgument);
  const base = env.baseRef;
  const comparisonBase = base && !/^0+$/.test(base) ? base : undefined;
  if (mode === 'snapshots') {
    // Editing a file already frozen at the base revision is always an error, even during development.
    checkSnapshotFiles(project, comparisonBase);
    report(env, 'Existing snapshot files are unchanged.');
    return;
  }
  // Development modes report advisory drift; release mode applies the hard readiness gate.
  const current = readCurrent(project);
  if (mode === 'pr') warnCompatibility(project, env, current, comparisonBase);
  if (mode === 'main') {
    const status = snapshotStatus(project);
    report(
      env,
      status.required
        ? `Snapshot required: current spec ${status.reason === 'missing' ? 'has no release snapshot' : `differs from ${status.latest}`}. Choose a release tag and run the snapshot command when ready.`
        : `Current spec matches ${status.latest}; no snapshot needed.`,
      status.required
    );
  }
  if (mode === 'release') releaseGate(project, env, current);
}
