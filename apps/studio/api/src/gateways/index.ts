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

/** The kinds of gateway organisations register, by kind. A gateway of any other kind cannot be connected to here. */
export const GATEWAY_KINDS = { mediamtx } satisfies Record<string, OrganisationProvider>;

export type BuiltinGatewayId = keyof typeof BUILTIN_GATEWAYS;
// SAFETY: the keys of BUILTIN_GATEWAYS, of which there is at least one.
const builtinGatewayIds = Object.keys(BUILTIN_GATEWAYS) as [BuiltinGatewayId, ...BuiltinGatewayId[]];
/** The built-in gateways' slugs, for the schemas that accept them. */
export const BUILTIN_GATEWAY_IDS = builtinGatewayIds;

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
 * Refuses an organisation's gateway its kind's provider cannot serve: settings it does not read (`invalid_settings`),
 * or a protocol it does not accept (`unsupported_protocol`). A kind with no provider is registered as it is.
 */
export function checkGatewayKind(kind: string, protocols: readonly string[], settings: Settings) {
  const provider = gatewayKind(kind);
  if (provider === undefined) return;
  if (!protocols.every(protocol => provider.protocols.includes(protocol))) throw new ApiFailure('unsupported_protocol');
  provider.checkSettings(settings);
}

/** The built-in gateways as the gateway routes return them, beside an organisation's own. */
export const builtinGateways = BUILTIN_GATEWAY_IDS.map(id => ({
  id,
  builtin: true,
  name: BUILTIN_GATEWAYS[id].name,
  kind: BUILTIN_GATEWAYS[id].kind,
  protocols: BUILTIN_GATEWAYS[id].protocols,
  networkId: null,
  settings: {},
  createdAt: null
}));
