import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { ReleaseDocumentSchema, releaseName } from './release-contracts.ts';

interface SnapshotStatus {
  required: boolean;
  latest: string | null;
  reason: 'missing' | 'drifted' | 'matching';
}

/** Compare stable release tags numerically, independently of file timestamps or lexical order. */
function compareReleases(a: string, b: string): number {
  const left = a.slice('gatekeeper-v'.length).split('.').map(BigInt);
  const right = b.slice('gatekeeper-v'.length).split('.').map(BigInt);
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

/** Read only: compare the complete generated bundle byte-for-byte, just like the tag release check. */
export function snapshotStatus(): SnapshotStatus {
  const current = readFileSync(new URL('../openapi.json', import.meta.url));
  ReleaseDocumentSchema.parse(JSON.parse(current.toString()));
  const directory = new URL('../snapshots/', import.meta.url);
  const entries = existsSync(directory) ? readdirSync(directory, { withFileTypes: true }) : [];
  const releases = entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => releaseName(entry.name.slice(0, -'.json'.length)))
    .sort(compareReleases);
  const latest = releases.at(-1);
  if (!latest) return { required: true, latest: null, reason: 'missing' };
  const snapshot = readFileSync(new URL(`${latest}.json`, directory));
  ReleaseDocumentSchema.parse(JSON.parse(snapshot.toString()));
  const required = !current.equals(snapshot);
  return { required, latest, reason: required ? 'drifted' : 'matching' };
}
