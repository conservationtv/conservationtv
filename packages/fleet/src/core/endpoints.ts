import { readCidrs } from './config';

export type ServiceEndpointTransport = 'tcp' | 'udp';
export type ServiceEndpointVisibility = 'public' | 'private' | 'loopback';
export type ServiceEndpointBinding = 'host' | 'compose';
export type ServiceRegistry = object;

export interface ServiceEndpointDefinition {
  service: string;
  port: number;
  targetPort?: number;
  transport: ServiceEndpointTransport;
  visibility: ServiceEndpointVisibility;
  binding?: ServiceEndpointBinding;
  scheme?: string;
  paths?: Record<string, string>;
  description?: string;
  sourceCidrs?: string[];
}

export interface ServiceEndpoint extends ServiceEndpointDefinition {
  id: string;
  owner: string;
  binding: ServiceEndpointBinding;
  targetPort: number;
}

export interface ServiceEndpointContribution {
  owner: string;
  services: ServiceRegistry;
  endpoints?: Record<string, ServiceEndpointDefinition>;
}

export function mergeServiceEndpoints(contributions: readonly ServiceEndpointContribution[]) {
  const endpoints: Record<string, ServiceEndpoint> = {};
  const hostListeners = new Map<string, ServiceEndpoint>();

  for (const contribution of contributions) {
    for (const [id, definition] of Object.entries(contribution.endpoints ?? {})) {
      addServiceEndpoint(id, definition, contribution, endpoints, hostListeners);
    }
  }
  return endpoints;
}

function addServiceEndpoint(
  id: string,
  definition: ServiceEndpointDefinition,
  contribution: ServiceEndpointContribution,
  endpoints: Record<string, ServiceEndpoint>,
  hostListeners: Map<string, ServiceEndpoint>
): void {
  validateEndpoint(id, definition, contribution);
  if (endpoints[id]) throw new Error(`Service endpoint id collision: "${id}".`);
  const endpoint = resolveServiceEndpoint(id, definition, contribution.owner);
  registerHostListener(endpoint, hostListeners);
  endpoints[id] = endpoint;
}

function resolveServiceEndpoint(id: string, definition: ServiceEndpointDefinition, owner: string): ServiceEndpoint {
  const binding = definition.binding ?? 'host';
  return {
    ...definition,
    id,
    owner,
    binding,
    targetPort: definition.targetPort ?? definition.port,
    sourceCidrs: resolvePublicSourceCidrs(definition, binding)
  };
}

function resolvePublicSourceCidrs(
  definition: ServiceEndpointDefinition,
  binding: ServiceEndpointBinding
): string[] | undefined {
  if (definition.visibility !== 'public') return undefined;
  if (binding !== 'host') return undefined;
  return definition.sourceCidrs ?? ['0.0.0.0/0', '::/0'];
}

function registerHostListener(endpoint: ServiceEndpoint, hostListeners: Map<string, ServiceEndpoint>): void {
  if (endpoint.binding !== 'host') return;
  const listenerKey = `${endpoint.transport}:${endpoint.port}`;
  const existing = hostListeners.get(listenerKey);
  if (existing && existing.service !== endpoint.service) {
    throw new Error(
      `Host listener collision on ${listenerKey}: endpoint "${existing.id}" is owned by service "${existing.service}", ` +
        `but endpoint "${endpoint.id}" is owned by service "${endpoint.service}".`
    );
  }
  hostListeners.set(listenerKey, endpoint);
}

export function requireServiceEndpoint(
  endpoints: Readonly<Record<string, ServiceEndpoint>>,
  id: string
): ServiceEndpoint {
  const endpoint = endpoints[id];
  if (!endpoint) throw new Error(`Required service endpoint "${id}" was not declared.`);
  return endpoint;
}

// Require a scheme and absolute path suffix, omitting the port only for standard HTTP or HTTPS.
export function serviceEndpointUrl(endpoint: ServiceEndpoint, hostname: string, path?: string): string {
  if (!endpoint.scheme) throw new Error(`Service endpoint "${endpoint.id}" does not declare a URL scheme.`);
  const defaultPort =
    (endpoint.scheme === 'https' && endpoint.port === 443) || (endpoint.scheme === 'http' && endpoint.port === 80);
  const suffix = path ?? '';
  if (suffix && !suffix.startsWith('/')) throw new Error(`Endpoint URL path must start with /: ${suffix}`);
  return `${endpoint.scheme}://${hostname}${defaultPort ? '' : `:${endpoint.port}`}${suffix}`;
}

function validateEndpoint(
  id: string,
  endpoint: ServiceEndpointDefinition,
  contribution: ServiceEndpointContribution
): void {
  validateEndpointId(id);
  validateEndpointService(id, endpoint.service, contribution);
  validateEndpointPort(id, endpoint.port);
  validateEndpointTargetPort(id, endpoint.targetPort);
  validateEndpointScheme(id, endpoint.scheme);
  validateEndpointSourceCidrs(id, endpoint);
  validateEndpointPaths(id, endpoint.paths);
}

function validateEndpointId(id: string): void {
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id)) {
    throw new Error(`Service endpoint id "${id}" must contain lowercase labels separated by . or -.`);
  }
}

function validateEndpointService(id: string, service: string, contribution: ServiceEndpointContribution): void {
  if (!Object.hasOwn(contribution.services, service)) {
    throw new Error(`Service endpoint "${id}" references unknown service "${service}" in ${contribution.owner}.`);
  }
}

function validateEndpointPort(id: string, port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Service endpoint "${id}" has invalid port ${port}.`);
  }
}

// Allow an omitted target port; supplied ports must be integers within the valid range.
function validateEndpointTargetPort(id: string, targetPort: number | undefined): void {
  if (targetPort === undefined) return;
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
    throw new Error(`Service endpoint "${id}" has invalid targetPort ${targetPort}.`);
  }
}

function validateEndpointScheme(id: string, scheme: string | undefined): void {
  if (scheme && !/^[a-z][a-z0-9+.-]*$/.test(scheme)) {
    throw new Error(`Service endpoint "${id}" has invalid scheme "${scheme}".`);
  }
}

function validateEndpointSourceCidrs(id: string, endpoint: ServiceEndpointDefinition): void {
  if (!endpoint.sourceCidrs) return;
  if (endpoint.visibility !== 'public') {
    throw new Error(`Service endpoint "${id}" can only declare sourceCidrs when visibility is public.`);
  }
  readCidrs(endpoint.sourceCidrs, `${id} sourceCidrs`);
}

// Validate each optional named path as a lowercase label paired with an absolute URL path.
function validateEndpointPaths(id: string, paths: Record<string, string> | undefined): void {
  for (const [name, path] of Object.entries(paths ?? {})) {
    if (!/^[a-z][a-z0-9-]*$/.test(name) || !path.startsWith('/')) {
      throw new Error(`Service endpoint "${id}" has invalid named path "${name}": "${path}".`);
    }
  }
}
