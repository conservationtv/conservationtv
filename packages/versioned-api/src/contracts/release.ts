import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { z } from 'zod';
import type { ContractsProject } from './config.js';

type Json = z.output<ReturnType<typeof z.json>>;
export const ReleaseDocumentSchema = z.record(z.string(), z.json());
export type ReleaseDocument = z.output<typeof ReleaseDocumentSchema>;
const object = (value: Json | undefined): ReleaseDocument => ReleaseDocumentSchema.safeParse(value).data ?? {};
const methods = new Set(['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace']);
const prose = new Set([
  'description',
  'summary',
  'tags',
  'example',
  'examples',
  'externalDocs',
  'x-operation-versions'
]);
const maps = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'responses',
  'headers',
  'content',
  'encoding',
  'links',
  'securitySchemes',
  'callbacks',
  'dependentSchemas',
  'mapping',
  'security'
]);
const literals = new Set(['const', 'enum', 'default']);

/** The project parts the release checks read. */
export type ReleaseProject = Pick<ContractsProject, 'document' | 'snapshots' | 'root' | 'paths' | 'release'>;

interface CanonicalState {
  references: Set<string>;
  mapKeys: boolean;
  literal: boolean;
}
interface Resolved {
  value: ReleaseDocument;
  state: CanonicalState;
  terminal: boolean;
}

/** Resolve schema references without confusing property names or literal data with OpenAPI keywords. */
class ContractCanonicalizer {
  constructor(private readonly document: ReleaseDocument) {}

  private resolve(value: ReleaseDocument, state: CanonicalState): Resolved {
    // References inside maps or literal data are ordinary property values. Cycles retain a stable reference marker.
    const parsed = z.string().safeParse(value.$ref);
    if (!parsed.success || state.mapKeys || state.literal) return { value, state, terminal: false };
    const ref = parsed.data;
    if (!ref.startsWith('#/')) throw new Error(`Release contracts require local references: ${ref}`);
    if (state.references.has(ref)) return { value: { $ref: ref }, state, terminal: true };
    const target = ref
      .slice(2)
      .split('/')
      .reduce<Json | undefined>(
        (node, part) => object(node)[part.replace(/~1/g, '/').replace(/~0/g, '~')],
        this.document
      );
    if (target === undefined) throw new Error(`Unresolved reference: ${ref}`);
    const { $ref: _, ...siblings } = value;
    const next = { ...state, references: new Set([...state.references, ref]) };
    const booleanSchema = z.boolean().safeParse(target);
    if (booleanSchema.success)
      return { value: { allOf: [booleanSchema.data, siblings] }, state: next, terminal: false };
    return this.resolve({ ...object(target), ...siblings }, next);
  }

  canonical(value: Json, state: CanonicalState): Json {
    // Walk validated JSON, resolving references and sorting object keys; retain names inside schema maps and literals.
    if (Array.isArray(value)) return value.map(item => this.canonical(item, state));
    const parsed = ReleaseDocumentSchema.safeParse(value);
    if (!parsed.success) return value;
    const resolved = this.resolve(parsed.data, state);
    if (resolved.terminal) return resolved.value;
    return Object.fromEntries(
      Object.keys(resolved.value)
        .sort()
        .filter(key => state.mapKeys || state.literal || !prose.has(key))
        .map(key => [
          key,
          this.canonical(resolved.value[key], {
            references: resolved.state.references,
            mapKeys: !state.mapKeys && maps.has(key),
            literal: state.literal || (!state.mapKeys && literals.has(key))
          })
        ])
    );
  }
}

function pathParameters(item: Json): Json {
  return object(item).parameters ?? [];
}

/** Extract frozen operations from one standalone document. */
function documentContracts(document: ReleaseDocument): Map<string, string> {
  const canonicalizer = new ContractCanonicalizer(document);
  const contracts = new Map<string, string>();
  const security = document.security ?? [];
  const servers = document.servers ?? [];
  const securitySchemes = object(document.components).securitySchemes ?? {};
  for (const [path, item] of Object.entries(object(document.paths))) {
    // Only HTTP operations with an explicit version are frozen; path-level settings remain part of each contract.
    for (const [method, entry] of Object.entries(object(item))) {
      // Freeze only versioned methods, including inherited settings and referenced schemas.
      if (!methods.has(method)) continue;
      const operation = object(entry);
      if (!z.number().int().positive().safeParse(operation['x-operation-version']).success) continue;
      const id = `${operation.operationId}@${operation['x-operation-version']}`;
      const contract = canonicalizer.canonical(
        {
          path,
          method,
          operation,
          parameters: pathParameters(item),
          security,
          servers,
          pathServers: object(item).servers ?? [],
          securitySchemes
        },
        { references: new Set(), mapKeys: false, literal: false }
      );
      if (contracts.has(id)) throw new Error(`Duplicate contract: ${id}`);
      contracts.set(id, JSON.stringify(contract));
    }
  }
  return contracts;
}

/** Strict equality: prose may evolve, but inputs, outputs, security and wire location may not. */
export function contractsOf(bundle: ReleaseDocument): Map<string, string> {
  const documents = Array.isArray(bundle['x-operation-contracts']) ? bundle['x-operation-contracts'] : [bundle];
  const contracts = new Map<string, string>();
  for (const document of documents) {
    for (const [id, contract] of documentContracts(object(document))) {
      if (contracts.has(id)) throw new Error(`Duplicate contract: ${id}`);
      contracts.set(id, contract);
    }
  }
  return contracts;
}

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

export interface CompatibilityChange {
  operation: string;
  kind: 'changed' | 'removed';
}

/** Conservative contract comparison: new versions are fine; changed or removed old versions need attention. */
export function compatibilityChanges(previous: ReleaseDocument, current: ReleaseDocument): CompatibilityChange[] {
  const next = contractsOf(current);
  const changes: CompatibilityChange[] = [];
  for (const [operation, contract] of contractsOf(previous)) {
    if (!next.has(operation)) changes.push({ operation, kind: 'removed' });
    else if (next.get(operation) !== contract) changes.push({ operation, kind: 'changed' });
  }
  return changes;
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
