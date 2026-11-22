import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ZodType } from 'zod';

// The studio API's contract, as the mock API reads it: which operation a request is (from the published OpenAPI
// document's paths), and what that operation's response must look like (from the SDK's generated schema for that
// version). A projection that drifts from the contract is caught here as it answers, and reported, rather than
// rendering data the real API could never send.

const API_CONTRACTS = new URL('../../../api/contracts/', import.meta.url);
const SDK_VERSIONS = new URL('../../../sdk/src/versions/', import.meta.url);

export const OPERATION_VERSION_HEADER = 'Operation-Version';

interface OpenApiOperation {
  operationId?: string;
  'x-operation-version'?: number;
  'x-operation-versions'?: number[];
}

export interface Operation {
  id: string;
  method: string;
  /** The path as the contract writes it, `/organisations/{id}/topology`. */
  template: string;
  /** The versions served; empty for a versionless operation. */
  versions: number[];
  pattern: RegExp;
  paramNames: string[];
}

export interface Matched {
  operation: Operation;
  params: Record<string, string>;
}

/** A path template as a pattern, and the names of the parameters its groups capture, in order. */
interface CompiledPath {
  pattern: RegExp;
  paramNames: string[];
}

function compile(template: string): CompiledPath {
  const paramNames: string[] = [];
  const source = template
    .replace(/[.*+?^$()|[\]\\]/gu, '\\$&')
    .replace(/\\?\{([^}]+)\\?\}/gu, (_match, name: string) => {
      paramNames.push(name);
      return '([^/]+)';
    });
  return { pattern: new RegExp(`^${source}$`, 'u'), paramNames };
}

/** The part of the published OpenAPI document read here: each path's operations, by method. */
interface OpenApiDocument {
  paths: Record<string, Record<string, OpenApiOperation>>;
}

function loadOperations(): Operation[] {
  const document: OpenApiDocument = JSON.parse(readFileSync(new URL('openapi.json', API_CONTRACTS), 'utf8'));
  const operations: Operation[] = [];
  for (const [template, methods] of Object.entries(document.paths)) {
    // Each method on the path is one operation, matched by the path's pattern.
    for (const [method, operation] of Object.entries(methods)) {
      // Only operations: a path's other keys (its parameters, say) have no ID. Older documents name one version.
      if (!operation.operationId) continue;
      const versions =
        operation['x-operation-versions'] ??
        (operation['x-operation-version'] ? [operation['x-operation-version']] : []);
      operations.push({
        id: operation.operationId,
        method: method.toUpperCase(),
        template,
        versions,
        ...compile(template)
      });
    }
  }
  // Literal segments before parameters: `/members/me` before `/members/{userId}`.
  return operations.sort((a, b) => a.paramNames.length - b.paramNames.length);
}

export const OPERATIONS = loadOperations();

/** The operation manifest the SDK's handshake reads, as the API publishes it. */
export const OPERATION_MANIFEST = readFileSync(new URL('operations.json', API_CONTRACTS), 'utf8');

export function matchOperation(method: string, path: string): Matched | undefined {
  for (const operation of OPERATIONS) {
    if (operation.method !== method) continue;
    const match = operation.pattern.exec(path);
    if (!match) continue;
    const params = Object.fromEntries(
      operation.paramNames.map((name, index) => [name, decodeURIComponent(match[index + 1] ?? '')])
    );
    return { operation, params };
  }
  return undefined;
}

const schemas = new Map<string, Promise<ZodType | undefined>>();

/** The response schema for the operation's version, from the SDK's generated code; undefined for versionless ones. */
export function responseSchema(operationId: string, version: number): Promise<ZodType | undefined> {
  const key = `${operationId}-v${version}`;
  let schema = schemas.get(key);
  if (!schema) {
    const file = fileURLToPath(new URL(`${key}/zod.gen.ts`, SDK_VERSIONS));
    schema = import(file).then(
      // SAFETY: a generated zod.gen.ts exports only Zod schemas.
      (module: Record<string, ZodType>) => {
        const name = Object.keys(module).find(exported => exported.endsWith('ResponseSchema'));
        return name ? module[name] : undefined;
      },
      () => undefined
    );
    schemas.set(key, schema);
  }
  return schema;
}
