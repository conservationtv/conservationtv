import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { contractsOf, ReleaseDocumentSchema, type ReleaseDocument } from './compare.js';
import type { ContractsProject } from './config.js';

/** The project parts the release checks read. */
export type ReleaseProject = Pick<ContractsProject, 'document' | 'snapshots' | 'root' | 'paths' | 'release'>;

export interface Release {
  name: string;
  document: ReleaseDocument;
}
interface ReleasedContract {
  contract: string;
  release: string;
}

/** Validate release history, allowing retirement but never reuse with a different contract. */
export function checkContractHistory(releases: Iterable<Release>): void {
  const released = new Map<string, ReleasedContract>();
  for (const { name, document } of releases) {
    for (const [id, contract] of contractsOf(document)) {
      const previous = released.get(id);
      if (previous && previous.contract !== contract) {
        throw new Error(
          `${id} is frozen by ${previous.release} and differs in ${name}. Register a new operation version.`
        );
      }
      released.set(id, { contract, release: name });
    }
  }
}

/** Read the current bundle as released JSON. */
export function readCurrent(project: ReleaseProject): ReleaseDocument {
  return ReleaseDocumentSchema.parse(JSON.parse(readFileSync(project.document, 'utf8')));
}

/** Read the immutable release history in a reusable form for gates and advisory checks. */
export function readReleases(project: ReleaseProject): Release[] {
  const names = existsSync(project.snapshots)
    ? readdirSync(project.snapshots)
        .filter(name => name.endsWith('.json'))
        .sort()
    : [];
  return names.map(name => ({
    name,
    document: ReleaseDocumentSchema.parse(JSON.parse(readFileSync(join(project.snapshots, name), 'utf8')))
  }));
}

/** Compare all releases, including versions removed from the current server and later reintroduced. */
export function checkReleasedContracts(project: ReleaseProject, current: ReleaseDocument): void {
  checkContractHistory([...readReleases(project), { name: 'current', document: current }]);
}

/** Existing snapshots cannot be changed or deleted; new snapshots are permitted. */
export function checkSnapshotFiles(project: ReleaseProject, base = 'HEAD'): void {
  // A freshly initialized starter has no frozen Git history until its first commit.
  const { root } = project;
  if (base === 'HEAD' && spawnSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: root }).status !== 0)
    return;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root });
  const paths = git('ls-tree', '-r', '--name-only', '-z', base, '--', project.paths.snapshots)
    .toString()
    .split('\0')
    .filter(Boolean);
  for (const path of paths) {
    const file = join(root, path);
    if (!existsSync(file) || !readFileSync(file).equals(git('show', `${base}:${path}`))) {
      throw new Error(`Released snapshot is immutable: ${path} (compared with ${base})`);
    }
  }
}

/** The bundle as committed at `base`, for PR compatibility warnings. */
export function readBundleAt(project: ReleaseProject, base: string): ReleaseDocument {
  return ReleaseDocumentSchema.parse(
    JSON.parse(
      execFileSync('git', ['show', `${base}:${project.paths.document}`], { cwd: project.root, encoding: 'utf8' })
    )
  );
}
