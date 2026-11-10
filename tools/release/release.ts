// One version for the whole repository: every API's contracts, the `ctv` CLI on npm and the agent image release
// together as `vX.Y.Z`, tagged by a GitHub release whose notes are the shared changelog. Run with Node, which strips
// the types:
//
//   node tools/release/release.ts prepare [major|minor|patch|X.Y.Z]
//     Snapshots each API whose contracts changed since the last release and sets the version, for a release PR.
//     Without a bump, it picks one from the contracts: major when an operation version is removed, minor when one is
//     added, patch otherwise.
//   node tools/release/release.ts verify <tag>
//     The release workflow's first check: the tag is the prepared version, on main.
//   node tools/release/release.ts notes <tag>
//     The contract changes a release makes, as Markdown for its release notes.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
/** The version lives in the root package.json; the CLI's carries the same, as npm publishes it. */
const VERSIONED = ['package.json', 'apps/cli/package.json'];
const RELEASE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

type Bump = 'major' | 'minor' | 'patch';
interface Api {
  name: string;
  dir: string;
}
interface Changes {
  previous: string | null;
  added: string[];
  changed: string[];
  removed: string[];
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function parse(version: string): [number, number, number] {
  const match = RELEASE.exec(version);
  if (!match) throw new Error(`Not a version: ${version}. Use X.Y.Z, or major, minor or patch.`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compare(a: string, b: string): number {
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index]! - right[index]!;
  return 0;
}

function bumped(version: string, bump: Bump): string {
  const [major, minor, patch] = parse(version);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function versionOf(file: string): string {
  return JSON.parse(readFileSync(join(root, file), 'utf8')).version;
}

/** Rewrite only the version line, so each file keeps its formatting. */
function setVersion(file: string, version: string): void {
  const path = join(root, file);
  const text = readFileSync(path, 'utf8');
  const next = text.replace(/^(\s*"version":\s*)"[^"]*"/m, `$1"${version}"`);
  if (next === text && versionOf(file) !== version) throw new Error(`${file} has no version to set`);
  writeFileSync(path, next);
}

/** The latest release tag reachable from HEAD, if any. */
function lastRelease(): string | undefined {
  const tags = git('tag', '--merged', 'HEAD', '--list', 'v*')
    .split('\n')
    .filter(tag => RELEASE.test(tag));
  return tags.sort(compare).at(-1);
}

/** Every API with contracts: each directory holding a contracts.config.ts. */
function apis(): Api[] {
  return git('ls-files', '*contracts.config.ts')
    .split('\n')
    .filter(Boolean)
    .map(file => {
      const dir = join(root, dirname(file));
      return { name: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name, dir };
    });
}

function contracts(api: Api, ...args: string[]): string {
  return execFileSync('pnpm', ['-s', 'exec', 'api-contracts', ...args], { cwd: api.dir, encoding: 'utf8' });
}

function changesOf(api: Api, tag?: string): Changes {
  const output = contracts(api, 'changes', ...(tag ? ['--tag', tag] : []));
  const changes: Changes = JSON.parse(output.trim().split('\n').at(-1) ?? '{}');
  return changes;
}

const BUMPS = new Set<string>(['major', 'minor', 'patch']);
function isBump(value: string): value is Bump {
  return BUMPS.has(value);
}

/** The bump the contracts call for: major when an operation version is removed, minor when one is added. */
function suggestedBump(all: Changes[]): Bump {
  const changed = all.flatMap(changes => changes.changed);
  if (changed.length) {
    throw new Error(`Released contracts changed: ${changed.join(', ')}. Register a new operation version for each.`);
  }
  if (all.some(changes => changes.removed.length)) return 'major';
  if (all.some(changes => changes.added.length)) return 'minor';
  return 'patch';
}

/** The version asked for, or the last release bumped as asked or as suggested. */
function requestedVersion(requested: string | undefined, last: string | undefined, suggested: Bump): string {
  if (requested !== undefined && !isBump(requested)) return parse(requested).join('.');
  if (!last) {
    throw new Error(`No release is tagged yet, so name the version (package.json has ${versionOf('package.json')}).`);
  }
  return bumped(last, requested ?? suggested);
}

/** The next version: never one older than the last release, and a warning when the contracts call for more. */
function nextVersion(requested: string | undefined, last: string | undefined, suggested: Bump): string {
  const version = requestedVersion(requested, last, suggested);
  if (last && compare(version, last) <= 0) throw new Error(`${version} is not newer than ${last}`);
  if (last && compare(version, bumped(last, suggested)) < 0) {
    console.warn(`Warning: the contracts suggest a ${suggested} release, and ${version} is less than that.`);
  }
  return version;
}

function prepare(requested: string | undefined): void {
  const all = apis();
  const last = lastRelease();
  const suggested = suggestedBump(all.map(api => changesOf(api)));
  const version = nextVersion(requested, last, suggested);
  const tag = `v${version}`;
  for (const api of all) {
    // Typecheck first, as CI does: it generates the Worker types the bundle is generated with.
    execFileSync('pnpm', ['-s', 'run', 'typecheck'], { cwd: api.dir, stdio: 'ignore' });
    const result = contracts(api, 'snapshot', tag).trim().split('\n').at(-1);
    console.log(`${api.name}: ${result}`);
  }
  for (const file of VERSIONED) setVersion(file, version);
  console.log(`
Prepared ${tag}${last ? ` (last release ${last}; the contracts suggest a ${suggested} release)` : ''}.
Commit the snapshots and versions as "Release ${tag}" in a pull request. Once it merges, publish the release from the
merge commit, which tags it and runs the release workflow:

  gh release create ${tag} --target <merge commit> --generate-notes`);
}

/** The tag is a version, every versioned package.json has it, and its commit is on main. */
function verify(tag: string | undefined): void {
  if (!tag || !tag.startsWith('v')) throw new Error('Pass the release tag, for example v1.0.0');
  const version = parse(tag).join('.');
  for (const file of VERSIONED) {
    if (versionOf(file) !== version) throw new Error(`${file} has version ${versionOf(file)}, not ${version}`);
  }
  try {
    git('merge-base', '--is-ancestor', 'HEAD', 'origin/main');
  } catch {
    throw new Error(`${tag} is not on main: release only commits main already has.`);
  }
  console.log(`${tag} matches the prepared version and is on main.`);
}

function bullets(operations: string[]): string[] {
  return operations.map(operation => `- \`${operation}\``);
}

/** One API's section of the notes: what the release adds and removes, or nothing when it did not change. */
function section(api: Api, tag: string): string[] {
  const { previous, added, removed } = changesOf(api, tag);
  if (!added.length && !removed.length) return [];
  // A first release adds everything, so it is summed up, with the list folded away.
  if (!previous) {
    const count = `${added.length} operation version${added.length === 1 ? '' : 's'}`;
    const list = ['<details><summary>Operation versions</summary>', '', ...bullets(added), '', '</details>'];
    return [`### ${api.name}`, '', `First release, with ${count}.`, '', ...list, ''];
  }
  const lines = [`### ${api.name} (since ${previous})`, ''];
  if (added.length) lines.push('Added:', ...bullets(added), '');
  if (removed.length) lines.push('Removed:', ...bullets(removed), '');
  return lines;
}

function notes(tag: string | undefined): void {
  if (!tag) throw new Error('Pass the release tag, for example v1.0.0');
  const sections = apis().flatMap(api => section(api, tag));
  const body = sections.length ? sections : ['No operation versions added or removed.', ''];
  console.log(['## Contract changes', '', ...body].join('\n'));
}

const [command, argument] = process.argv.slice(2);
try {
  if (command === 'prepare') prepare(argument);
  else if (command === 'verify') verify(argument);
  else if (command === 'notes') notes(argument);
  else
    throw new Error(
      'Usage: node tools/release/release.ts <prepare [major|minor|patch|X.Y.Z]|verify <tag>|notes <tag>>'
    );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
