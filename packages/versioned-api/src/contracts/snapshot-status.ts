import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareReleases, releaseName } from './config.js';
import { ReleaseDocumentSchema } from './compare.js';
import type { ReleaseProject } from './release.js';

export interface SnapshotStatus {
  required: boolean;
  latest: string | null;
  reason: 'missing' | 'drifted' | 'matching';
}

/** The releases this API froze a snapshot in, oldest first. A release it did not change in has none. */
export function snapshotNames(project: Pick<ReleaseProject, 'snapshots'>): string[] {
  const entries = existsSync(project.snapshots) ? readdirSync(project.snapshots, { withFileTypes: true }) : [];
  return entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => releaseName(entry.name.slice(0, -'.json'.length)))
    .sort(compareReleases);
}

/**
 * Read only: compare the complete generated bundle byte-for-byte with the latest snapshot, or with the latest at or
 * before `release`, which is what that release serves when the API did not change in it.
 */
export function snapshotStatus(project: ReleaseProject, release?: string): SnapshotStatus {
  const current = readFileSync(project.document);
  ReleaseDocumentSchema.parse(JSON.parse(current.toString()));
  const names = snapshotNames(project);
  const latest = (release === undefined ? names : names.filter(name => compareReleases(name, release) <= 0)).at(-1);
  if (!latest) return { required: true, latest: null, reason: 'missing' };
  const snapshot = readFileSync(join(project.snapshots, `${latest}.json`));
  ReleaseDocumentSchema.parse(JSON.parse(snapshot.toString()));
  const required = !current.equals(snapshot);
  return { required, latest, reason: required ? 'drifted' : 'matching' };
}
