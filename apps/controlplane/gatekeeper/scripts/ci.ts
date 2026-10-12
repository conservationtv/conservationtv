import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  ReleaseDocumentSchema,
  checkReleasedContracts,
  checkSnapshotFiles,
  compatibilityChanges,
  readReleases,
  releaseName,
  type ReleaseDocument
} from './release-contracts.ts';
import { snapshotStatus } from './snapshot-status.ts';

const ModeSchema = z.enum(['pr', 'main', 'release', 'snapshots']);
type Mode = z.output<typeof ModeSchema>;
const root = fileURLToPath(new URL('../../../../', import.meta.url));

/** GitHub annotations use escaped newlines and percent signs; ordinary local runs print the same readable message. */
function report(message: string, warning = false): void {
  console.log(message);
  if (process.env.GITHUB_ACTIONS === 'true' && warning) {
    const escaped = message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    console.log(`::warning title=API contracts::${escaped}`);
  }
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) appendFileSync(summary, `- ${message}\n`);
}

/** Compare both the PR base and released history, so removing a snapshot cannot hide a published contract. */
function warnCompatibility(current: ReleaseDocument, base: string | undefined): void {
  if (!base) throw new Error('PR compatibility requires API_BASE_REF');
  const previous = ReleaseDocumentSchema.parse(
    JSON.parse(
      execFileSync('git', ['show', `${base}:apps/controlplane/gatekeeper/openapi.json`], {
        cwd: root,
        encoding: 'utf8'
      })
    )
  );
  const baselines = [{ name: 'PR base', document: previous }, ...readReleases()];
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
  for (const message of warnings.values()) report(message, true);
  if (!warnings.size) report('No changed or removed versioned contracts detected.');
}

/** Drift is advisory on main; an API release must pass both frozen-history and exact snapshot checks. */
function releaseGate(current: ReleaseDocument): void {
  const tag = releaseName(process.env.API_RELEASE_TAG);
  checkSnapshotFiles();
  checkReleasedContracts(current);
  const status = snapshotStatus();
  if (status.required) throw new Error(`Release blocked: snapshot required (${status.reason}).`);
  if (status.latest !== tag) throw new Error(`Release blocked: ${tag} is not the latest snapshot (${status.latest}).`);
  report(`${tag} is snapshot ready; frozen contracts and exact snapshot equality passed.`);
}

const mode: Mode = ModeSchema.parse(process.argv[2]);
const base = process.env.API_BASE_REF;
const comparisonBase = base && !/^0+$/.test(base) ? base : undefined;
if (mode === 'snapshots') {
  // Editing a file already frozen at the base revision is always an error, even during development.
  checkSnapshotFiles(comparisonBase);
  report('Existing snapshot files are unchanged.');
} else {
  // Development modes report advisory drift; release mode applies the hard readiness gate.
  const current = ReleaseDocumentSchema.parse(
    JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'))
  );
  if (mode === 'pr') warnCompatibility(current, comparisonBase);
  if (mode === 'main') {
    const status = snapshotStatus();
    report(
      status.required
        ? `Snapshot required: current spec ${status.reason === 'missing' ? 'has no release snapshot' : `differs from ${status.latest}`}. Choose a release tag and run the snapshot command when ready.`
        : `Current spec matches ${status.latest}; no snapshot needed.`,
      status.required
    );
  }
  if (mode === 'release') releaseGate(current);
}
