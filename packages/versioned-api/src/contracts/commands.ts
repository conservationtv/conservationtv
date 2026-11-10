import { appendFileSync, constants, copyFileSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { compareReleases, releaseName, type ContractsProject } from './config.js';
import { generateBundle } from './openapi.js';
import { compatibilityChanges, contractChanges, type ContractChanges, type ReleaseDocument } from './compare.js';
import {
  checkReleasedContracts,
  checkSnapshotFiles,
  readBundleAt,
  readCurrent,
  readReleases,
  readSnapshot
} from './release.js';
import { snapshotNames, snapshotStatus } from './snapshot-status.js';

/**
 * Regenerate first; freeze a complete release bundle and never overwrite an existing snapshot. An API whose bundle is
 * unchanged since its latest snapshot gets none: the release serves that snapshot's contracts.
 */
export async function snapshot(project: ContractsProject, tag: string | undefined): Promise<void> {
  const name = releaseName(tag);
  checkSnapshotFiles(project);
  await generateBundle(project);
  checkReleasedContracts(project, readCurrent(project));
  const latest = snapshotNames(project).at(-1);
  if (latest !== undefined && compareReleases(name, latest) <= 0) {
    throw new Error(`${name} is not newer than the latest snapshot, ${latest}`);
  }
  const status = snapshotStatus(project);
  if (!status.required) {
    console.log(`Unchanged since ${status.latest}, so ${name} serves that snapshot: none written.`);
    return;
  }
  mkdirSync(project.snapshots, { recursive: true });
  const file = join(project.snapshots, `${name}.json`);
  copyFileSync(project.document, file, constants.COPYFILE_EXCL);
  console.log(
    `Wrote ${relative(project.dir, file)}. Commit it in the release PR; the release tags that commit ${name}.`
  );
}

export interface CheckReleaseOptions {
  base?: string;
  tag?: string;
}

/** Frozen snapshots are unchanged and no released contract differs; with a tag, the bundle is what it serves. */
export function checkRelease(project: ContractsProject, options: CheckReleaseOptions): void {
  checkSnapshotFiles(project, options.base ?? 'HEAD');
  checkReleasedContracts(project, readCurrent(project));
  if (options.tag !== undefined) {
    const name = releaseName(options.tag);
    const status = snapshotStatus(project, name);
    if (status.required) throw new Error(`${name}: openapi.json differs from ${status.latest ?? 'every snapshot'}`);
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

/**
 * Drift is advisory on main; a release must pass both frozen-history and exact snapshot checks. The bundle must equal
 * the release's own snapshot, or, when the API did not change in it, the latest one before it.
 */
function releaseGate(project: ContractsProject, env: CiEnvironment, current: ReleaseDocument): void {
  const tag = releaseName(env.releaseTag);
  checkSnapshotFiles(project);
  checkReleasedContracts(project, current);
  const status = snapshotStatus(project, tag);
  if (status.required) throw new Error(`Release blocked: snapshot required (${status.reason}).`);
  report(env, `${tag} serves ${status.latest}; frozen contracts and exact snapshot equality passed.`);
}

export interface Changes extends ContractChanges {
  /** The snapshot compared with: the one before the release's, or the latest when comparing the current bundle. */
  previous: string | null;
}

/**
 * What a release changes in this API's contracts. With a tag: its snapshot against the one before it, or nothing when
 * the API did not change in it. Without one: the current bundle against the latest snapshot, for the next release.
 */
export function changes(project: ContractsProject, tag: string | undefined): Changes {
  const names = snapshotNames(project);
  if (tag === undefined) {
    const previous = names.at(-1) ?? null;
    return {
      previous,
      ...contractChanges(previous ? readSnapshot(project, previous) : undefined, readCurrent(project))
    };
  }
  const name = releaseName(tag);
  const index = names.indexOf(name);
  if (index === -1) {
    const previous = names.filter(other => compareReleases(other, name) < 0).at(-1) ?? null;
    return { previous, added: [], changed: [], removed: [] };
  }
  const previous = names[index - 1] ?? null;
  const document = readSnapshot(project, name);
  return { previous, ...contractChanges(previous ? readSnapshot(project, previous) : undefined, document) };
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
