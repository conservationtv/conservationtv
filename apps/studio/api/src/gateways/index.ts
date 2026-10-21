import { ApiFailure } from '../errors.ts';
import type { Settings } from '../topology/settings.ts';
import { conservationtv } from './conservationtv.ts';
import { mediamtx } from './mediamtx.ts';
import type { GatewayProvider, OrganisationProvider } from './provider.ts';

// Every gateway provider (src/gateways/provider.ts), and so every gateway this API connects callers to.

/**
 * The built-in gateways, by the slug that is their ID: always on the internet, configured by the deployment. Removing
 * one that exposures still use strands them: migrate them first.
 */
export const BUILTIN_GATEWAYS = { conservationtv };

/** The kinds of gateway organisations register, by kind: the only kinds there are. */
export const GATEWAY_KINDS = { mediamtx } satisfies Record<string, OrganisationProvider>;

export type BuiltinGatewayId = keyof typeof BUILTIN_GATEWAYS;
// SAFETY: the keys of BUILTIN_GATEWAYS, of which there is at least one.
const builtinGatewayIds = Object.keys(BUILTIN_GATEWAYS) as [BuiltinGatewayId, ...BuiltinGatewayId[]];
/** The built-in gateways' slugs, for the schemas that accept them. */
export const BUILTIN_GATEWAY_IDS = builtinGatewayIds;

export type GatewayKind = keyof typeof GATEWAY_KINDS;
// SAFETY: the keys of GATEWAY_KINDS, of which there is at least one.
const gatewayKindIds = Object.keys(GATEWAY_KINDS) as [GatewayKind, ...GatewayKind[]];
/** The kinds organisations register gateways of, for the schemas that accept them. */
export const GATEWAY_KIND_IDS = gatewayKindIds;

export function isBuiltinGateway(gatewayId: string): gatewayId is BuiltinGatewayId {
  return Object.hasOwn(BUILTIN_GATEWAYS, gatewayId);
}

function isGatewayKind(kind: string): kind is keyof typeof GATEWAY_KINDS {
  return Object.hasOwn(GATEWAY_KINDS, kind);
}

/** The provider of an organisation's gateways of this kind, if there is one. */
export function gatewayKind(kind: string): OrganisationProvider | undefined {
  return isGatewayKind(kind) ? GATEWAY_KINDS[kind] : undefined;
}

/** A gateway's provider: its own if it is built in, otherwise its kind's; `unsupported_gateway` if it has none. */
export function gatewayProvider(gatewayId: string, kind: string): GatewayProvider {
  if (isBuiltinGateway(gatewayId)) return BUILTIN_GATEWAYS[gatewayId];
  const provider = gatewayKind(kind);
  if (provider === undefined) throw new ApiFailure('unsupported_gateway');
  return provider;
}

/**
 * Refuses settings an organisation's gateway of this kind cannot be registered with (`invalid_settings`), or a kind
 * there is no provider for (`unsupported_gateway`), which only a gateway older than its kind's removal can have.
 */
export function checkGatewaySettings(kind: string, settings: Settings) {
  const provider = gatewayKind(kind);
  if (provider === undefined) throw new ApiFailure('unsupported_gateway');
  provider.checkSettings(settings);
}

/** A built-in gateway as the gateway routes return it, in the shape of an organisation's own. */
export interface BuiltinGatewayListing {
  id: BuiltinGatewayId;
  builtin: true;
  name: string;
  kind: string;
  networkId: null;
  settings: Settings;
  createdAt: null;
}

/** The built-in gateways as the gateway routes return them, beside an organisation's own. */
export const builtinGateways = BUILTIN_GATEWAY_IDS.map((id): BuiltinGatewayListing => ({
  id,
  builtin: true,
  name: BUILTIN_GATEWAYS[id].name,
  kind: BUILTIN_GATEWAYS[id].kind,
  networkId: null,
  settings: {},
  createdAt: null
}));
