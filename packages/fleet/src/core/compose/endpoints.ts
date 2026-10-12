import type { ComposeApp, FirewallRule, ServiceEndpoint, ServiceEndpointDefinition } from '../contracts';
import { mergeFirewallRules } from '../firewall';
import { ANYWHERE, assertPort, readCidrs } from '../validate';

const ENDPOINT_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const SCHEME = /^[a-z][a-z0-9+.-]*$/;
const PATH_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * Validate an app's endpoint definitions and fill in defaults. Several endpoints may describe
 * routes on one listener, but only if a single service owns it.
 */
export function resolveEndpoints(app: ComposeApp): Record<string, ServiceEndpoint> {
  const resolved = Object.entries(app.endpoints ?? {}).map(([id, definition]) => resolveEndpoint(id, definition, app));
  const owners = new Map<string, ServiceEndpoint>();
  for (const endpoint of resolved.filter(candidate => candidate.binding === 'host')) {
    const key = listenerKey(endpoint);
    const existing = owners.get(key);
    if (existing && existing.service !== endpoint.service) {
      throw new Error(
        `Host listener collision on ${key} in app "${app.name}": endpoint "${existing.id}" belongs to service ` +
          `"${existing.service}" but endpoint "${endpoint.id}" belongs to service "${endpoint.service}".`
      );
    }
    owners.set(key, endpoint);
  }
  return Object.fromEntries(resolved.map(endpoint => [endpoint.id, endpoint]));
}

/** `${transport}:${port}` for every host-bound listener, as claimed on the machine. */
export function hostListeners(endpoints: Readonly<Record<string, ServiceEndpoint>>): string[] {
  const keys = Object.values(endpoints)
    .filter(endpoint => endpoint.binding === 'host')
    .map(listenerKey);
  return [...new Set(keys)];
}

/** Inbound rules for public host listeners, unioning sources of endpoints that share one. */
export function endpointIngress(endpoints: Readonly<Record<string, ServiceEndpoint>>): FirewallRule[] {
  return mergeFirewallRules(
    Object.values(endpoints)
      .filter(endpoint => endpoint.binding === 'host' && endpoint.visibility === 'public')
      .map(endpoint => ({
        protocol: endpoint.transport,
        port: endpoint.port,
        sourceCidrs: endpoint.sourceCidrs ?? [...ANYWHERE]
      }))
  );
}

export function requireEndpoint(endpoints: Readonly<Record<string, ServiceEndpoint>>, id: string): ServiceEndpoint {
  const endpoint = endpoints[id];
  if (!endpoint) throw new Error(`Required service endpoint "${id}" was not declared.`);
  return endpoint;
}

/** A URL for `endpoint` at `hostname`, omitting the port when it is the scheme's default. */
export function endpointUrl(endpoint: ServiceEndpoint, hostname: string, path = ''): string {
  if (!endpoint.scheme) throw new Error(`Service endpoint "${endpoint.id}" does not declare a URL scheme.`);
  if (path && !path.startsWith('/')) throw new Error(`Endpoint URL path must start with /, got "${path}".`);
  const defaultPort =
    (endpoint.scheme === 'https' && endpoint.port === 443) || (endpoint.scheme === 'http' && endpoint.port === 80);
  return `${endpoint.scheme}://${hostname}${defaultPort ? '' : `:${endpoint.port}`}${path}`;
}

function resolveEndpoint(id: string, definition: ServiceEndpointDefinition, app: ComposeApp): ServiceEndpoint {
  const what = `Service endpoint "${id}" in app "${app.name}"`;
  assertEndpointDefinition(what, id, definition, app);
  const binding = definition.binding ?? 'host';
  // Public host listeners always carry explicit sources because they become firewall rules.
  const sourceCidrs =
    definition.visibility === 'public' && binding === 'host'
      ? readCidrs(definition.sourceCidrs ?? ANYWHERE, `${what} sourceCidrs`)
      : definition.sourceCidrs && readCidrs(definition.sourceCidrs, `${what} sourceCidrs`);
  return {
    ...definition,
    id,
    owner: app.name,
    binding,
    targetPort: definition.targetPort ?? definition.port,
    sourceCidrs
  };
}

// Each check rejects one malformed field; together they make every resolved endpoint safe to render and expose.
function assertEndpointDefinition(
  what: string,
  id: string,
  definition: ServiceEndpointDefinition,
  app: ComposeApp
): void {
  if (!ENDPOINT_ID.test(id)) throw new Error(`${what} must be lowercase labels separated by . or -.`);
  if (!Object.hasOwn(app.services, definition.service)) {
    throw new Error(`${what} references unknown service "${definition.service}".`);
  }
  assertPort(definition.port, `${what} port`);
  if (definition.targetPort !== undefined) assertPort(definition.targetPort, `${what} targetPort`);
  if (definition.scheme !== undefined && !SCHEME.test(definition.scheme)) {
    throw new Error(`${what} has invalid scheme "${definition.scheme}".`);
  }
  for (const [name, path] of Object.entries(definition.paths ?? {})) assertNamedPath(what, name, path);
  if (definition.sourceCidrs && definition.visibility !== 'public') {
    throw new Error(`${what} may only declare sourceCidrs when its visibility is public.`);
  }
}

function assertNamedPath(what: string, name: string, path: string): void {
  if (!PATH_NAME.test(name) || !path.startsWith('/'))
    throw new Error(`${what} has invalid named path "${name}": "${path}".`);
}

function listenerKey(endpoint: ServiceEndpoint): string {
  return `${endpoint.transport}:${endpoint.port}`;
}
