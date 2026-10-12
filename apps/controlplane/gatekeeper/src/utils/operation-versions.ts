import type { H, RouterRoute } from 'hono/types';
import type { Router, Result, Params } from 'hono/router';
import { TrieRouter } from 'hono/router/trie-router';
import { findTargetHandler } from 'hono/utils/handler';
import { uniqueSymbol, type DescribeRouteOptions } from 'hono-openapi';
import { z } from 'zod';
import { OperationVersionMismatchError } from '../errors.ts';

export const OPERATION_VERSION_HEADER = 'Operation-Version';

export interface OperationRoute {
  operationId: string;
  version?: number;
  method: string;
  path: string;
  routes: RouterRoute[];
}

type Entry = [H, RouterRoute];

interface OperationDescription extends DescribeRouteOptions {
  'x-operation-version'?: number;
}
interface OpenApiMetadata {
  spec?: OperationDescription;
}
interface HandlerMetadata {
  [uniqueSymbol]?: OpenApiMetadata;
}
type DescribedHandler = H & HandlerMetadata;
const IdentitySchema = z.object({
  operationId: z.string().regex(/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/),
  'x-operation-version': z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()
});
type Identity = z.output<typeof IdentitySchema>;

/** Read the same metadata hono-openapi uses. Put describeRoute first in each operation's handler list. */
export function routeDescription(handler: H): OperationDescription | undefined {
  // SAFETY: hono-openapi attaches its optional metadata under this exported symbol, including on composed handlers.
  return (findTargetHandler(handler) as DescribedHandler)[uniqueSymbol]?.spec;
}

/**
 * Keeps Hono's public paths, parameter matching and middleware composition intact. The path router finds candidates;
 * request-aware guards select an entire operation version before any of its validators or handlers can execute.
 * Metadata stays on app.routes unchanged, so generation can project each complete route into its own contract.
 */
export class OperationRouter implements Router<Entry> {
  readonly name = 'OperationRouter';
  readonly operations: OperationRoute[] = [];
  private readonly router = new TrieRouter<Entry>();
  private readonly owners = new WeakMap<RouterRoute, OperationRoute>();
  private readonly active = new Map<string, OperationRoute>();
  private readonly identities = new Set<string>();
  private readonly locations = new Map<string, string>();

  /** A description begins a complete route; subsequent validators and handlers belong to it. */
  add(method: string, path: string, entry: Entry): void {
    const description = routeDescription(entry[0]);
    const key = `${method} ${path}`;
    if (description?.operationId) this.register(description, method, path, key);
    else if (description) this.active.delete(key);
    const owner = this.active.get(key);
    if (owner) {
      owner.routes.push(entry[1]);
      this.owners.set(entry[1], owner);
    }
    this.router.add(method, path, entry);
  }

  /** Validate identity and wire location once, when the operation is registered. */
  private register(description: OperationDescription, method: string, path: string, key: string): void {
    const identityData: Identity = IdentitySchema.parse(description);
    const { operationId, 'x-operation-version': version } = identityData;
    const identity = `${operationId}@${version ?? 'versionless'}`;
    if (this.identities.has(identity)) throw new Error(`Duplicate operation: ${identity}`);
    const location = this.locations.get(operationId);
    if (location && location !== key) throw new Error(`${operationId}: versions must use the same method and path`);
    const previous = this.active.get(key);
    if (previous && (previous.operationId !== operationId || previous.version === undefined || version === undefined)) {
      throw new Error(`${key}: duplicate routes must share an operationId and declare distinct versions`);
    }
    const operation: OperationRoute = { operationId, version, method, path, routes: [] };
    this.operations.push(operation);
    this.active.set(key, operation);
    this.identities.add(identity);
    this.locations.set(operationId, key);
  }

  match(method: string, path: string): Result<Entry> {
    // SAFETY: the concrete TrieRouter returns direct string parameter maps, never RegExpRouter index stashes.
    const result = this.router.match(method, path) as [Array<[Entry, Params]>];
    const candidates = new Map<string, OperationRoute[]>();
    for (const [[, route]] of result[0]) {
      const owner = this.owners.get(route);
      if (!owner) continue;
      const list = candidates.get(owner.operationId) ?? [];
      if (!list.includes(owner)) list.push(owner);
      candidates.set(owner.operationId, list);
    }
    // Fresh wrappers per match; concurrent requests never share selection state.
    const handlers = result[0].map(([entry, params]): [Entry, Params] => {
      const [handler, route] = entry;
      const owner = this.owners.get(route);
      if (!owner) return [entry, params];
      const versions = candidates.get(owner.operationId)!;
      const latest = versions.reduce((a, b) => ((a.version ?? 0) > (b.version ?? 0) ? a : b));
      const guarded: H = (c, next) => {
        // CORS preflight middleware terminates before reaching operation guards.
        const requested = c.req.header(OPERATION_VERSION_HEADER);
        const selected =
          requested === undefined
            ? latest
            : versions.find(v => v.version !== undefined && String(v.version) === requested);
        if (!selected) {
          throw new OperationVersionMismatchError(
            owner.operationId,
            versions.flatMap(v => v.version ?? []),
            requested!
          );
        }
        return selected === owner ? handler(c, next) : next();
      };
      return [[guarded, route], params];
    });
    // Preserve TrieRouter parameter maps alongside the guarded handlers.
    return [handlers];
  }
}
