import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { minimumVersions } from '../minimum-versions.js';

/** Stable generation directory for a frozen operation/version, or `current` for versionless operations. */
export type Source = string;
export const CURRENT: Source = 'current';

const SelectorHeader = 'operation-version';

// The parts of a spec bundle generation reads. Loose objects keep every other member, so a parsed document is still a
// complete standalone contract for Hey API.
const ParameterSchema = z.looseObject({ in: z.string().optional(), name: z.string().optional() });
export type Parameter = z.output<typeof ParameterSchema>;

const SpecOperationSchema = z.looseObject({
  operationId: z.string().optional(),
  'x-operation-version': z.int().positive().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  parameters: z.array(ParameterSchema).optional(),
  requestBody: z.json().optional()
});
export type SpecOperation = z.output<typeof SpecOperationSchema>;

const methods = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'] as const;
type Method = (typeof methods)[number];
const isMethod = (key: string): key is Method => methods.some(method => method === key);

const PathItemSchema = z.looseObject({
  ...Object.fromEntries(methods.map(method => [method, SpecOperationSchema.optional()])),
  parameters: z.array(ParameterSchema).optional()
});
export type PathItem = z.output<typeof PathItemSchema>;

const SpecDocumentSchema = z.looseObject({ paths: z.record(z.string(), PathItemSchema).optional() });
export type SpecDocument = z.output<typeof SpecDocumentSchema>;

const SpecBundleSchema = SpecDocumentSchema.extend({ 'x-operation-contracts': z.array(SpecDocumentSchema).optional() });
export type SpecBundle = z.output<typeof SpecBundleSchema>;

/** An operation as one spec describes it. */
export interface SpecEntry {
  operationId: string;
  /** Absent for a versionless operation, which has no compatibility guarantees. */
  version?: number;
  /** The Hey API filter key, like `POST /grants/exchange`. */
  key: string;
  source: Source;
  file: string;
  /** Complete standalone contract, extracted from the release bundle. */
  document: SpecDocument;
  /** The operation's summary and description, as in that spec. */
  description: string;
  /** Whether the generated SDK method takes parameters before its options. */
  hasParams: boolean;
}

/** A frozen operation contract, generated once under its stable operation/version identity. */
export interface OperationVersion extends SpecEntry {
  version: number;
}

export interface Operations {
  /** The current spec's operationIds, in its order. */
  order: string[];
  versioned: OperationVersion[];
  /** Operations the current spec gives no version, generated from the current spec alone. */
  versionless: SpecEntry[];
}

interface Snapshot {
  source: Source;
  file: string;
}

/**
 * The operations the client supports. The current spec decides whether an operation is versioned: one it gives no
 * version is versionless, generated from the current spec, and any versions in older snapshots are dropped.
 *
 * For versioned operations, sources are read oldest first: the snapshots in the API's `snapshots/` in release order,
 * then the current spec. A version is generated from the first source it appears in, since a server that serves it may
 * be running any release since then. Versions below `minimumVersions` (in minimum-versions.ts) are dropped, and so are
 * versionless snapshot entries.
 */
export function readOperations(spec: string): Operations {
  const directory = join(dirname(spec), 'snapshots');
  const entries = existsSync(directory) ? readdirSync(directory, { withFileTypes: true }) : [];
  const snapshots: Snapshot[] = entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => ({ source: entry.name.slice(0, -'.json'.length), file: join(directory, entry.name) }))
    .sort((a, b) => a.source.localeCompare(b.source, 'en', { numeric: true }));
  const current = operationsOf(spec, CURRENT);
  const versionless = current.filter(operation => operation.version === undefined);
  const unversioned = new Set(versionless.map(operation => operation.operationId));

  const found = new Map<string, OperationVersion>();
  for (const { source, file } of snapshots) addVersions(found, operationsOf(file, source), unversioned);
  addVersions(found, current, unversioned);
  return { order: current.map(operation => operation.operationId), versioned: [...found.values()], versionless };
}

function isRetained(operationId: string, version: number | undefined, unversioned: Set<string>): version is number {
  return version !== undefined && !unversioned.has(operationId) && version >= (minimumVersions[operationId] ?? 1);
}

function addVersions(found: Map<string, OperationVersion>, operations: SpecEntry[], unversioned: Set<string>) {
  for (const operation of operations) {
    const { operationId, version } = operation;
    if (!isRetained(operationId, version, unversioned)) continue;
    const id = `${operationId}@${version}`;
    if (!found.has(id)) found.set(id, { ...operation, version, source: `${operationId}-v${version}` });
  }
}

/** Client supplies the selector header; keep it out of callers' flat Params. */
const isSelectorHeader = (parameter: Parameter) =>
  parameter.in === 'header' && parameter.name?.toLowerCase() === SelectorHeader;

interface EntryContext {
  source: Source;
  file: string;
  document: SpecDocument;
  /** Whether this document is a bundle's top level, whose versioned operations are described by its catalog. */
  catalogued: boolean;
}

/** One method of one path item, or nothing when the bundle's catalog describes it instead. */
function entryOf(context: EntryContext, path: string, item: PathItem, method: Method): SpecEntry | undefined {
  const operation = SpecOperationSchema.optional().parse(item[method]);
  if (!operation) return undefined;
  const { operationId, 'x-operation-version': version } = operation;
  if (!operationId) throw new Error(`${context.source}: missing operationId on ${method.toUpperCase()} ${path}`);
  if (context.catalogued && version !== undefined) return undefined;
  if (version !== undefined)
    operation.parameters = operation.parameters?.filter(parameter => !isSelectorHeader(parameter));
  item[method] = operation;
  const key = `${method.toUpperCase()} ${path}`;
  const { source, file, document } = context;
  return { operationId, version, key, source, file, document, ...summary(item, operation) };
}

interface EntrySummary {
  description: string;
  hasParams: boolean;
}

/** The command/method description, and whether any parameter or body precedes the generated method's options. */
function summary(item: PathItem, operation: SpecOperation): EntrySummary {
  const description = [...new Set([operation.summary, operation.description].filter(Boolean))].join('\n\n');
  const hasParams = Boolean(item.parameters?.length || operation.parameters?.length || operation.requestBody);
  return { description, hasParams };
}

function operationsOf(file: string, source: Source): SpecEntry[] {
  const bundle = SpecBundleSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  const { 'x-operation-contracts': contracts, ...top } = bundle;
  const documents = contracts ? [top, ...contracts] : [top];
  return documents.flatMap(document => {
    const context = { source, file, document, catalogued: document === top && contracts !== undefined };
    // In the spec's order, which the generated members follow.
    return Object.entries(document.paths ?? {}).flatMap(([path, item]) =>
      Object.keys(item)
        .filter(isMethod)
        .flatMap(method => entryOf(context, path, item, method) ?? [])
    );
  });
}
