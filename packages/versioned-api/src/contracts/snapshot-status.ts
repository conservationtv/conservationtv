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

/** Read only: compare the complete generated bundle byte-for-byte, just like the tag release check. */
export function snapshotStatus(project: ReleaseProject): SnapshotStatus {
  const current = readFileSync(project.document);
  ReleaseDocumentSchema.parse(JSON.parse(current.toString()));
  const entries = existsSync(project.snapshots) ? readdirSync(project.snapshots, { withFileTypes: true }) : [];
  const releases = entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => releaseName(project, entry.name.slice(0, -'.json'.length)))
    .sort((a, b) => compareReleases(project, a, b));
  const latest = releases.at(-1);
  if (!latest) return { required: true, latest: null, reason: 'missing' };
  const snapshot = readFileSync(join(project.snapshots, `${latest}.json`));
  ReleaseDocumentSchema.parse(JSON.parse(snapshot.toString()));
  const required = !current.equals(snapshot);
  return { required, latest, reason: required ? 'drifted' : 'matching' };
}
