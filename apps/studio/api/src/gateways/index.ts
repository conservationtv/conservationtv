import { useEnvironment } from '../env/env.ts';
import { ApiFailure } from '../errors.ts';
import type { Settings } from '../topology/settings.ts';
import { cloudflareMoq } from './cloudflare-moq.ts';
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
export const GATEWAY_KINDS = { mediamtx, 'cloudflare-moq': cloudflareMoq } satisfies Record<
  string,
  OrganisationProvider
>;

/** An object's keys, as the non-empty tuple `z.enum` takes. */
function keysOf<Registry extends Record<string, GatewayProvider>>(registry: Registry) {
  // SAFETY: each registry lists at least one provider.
  return Object.keys(registry) as [keyof Registry & string, ...(keyof Registry & string)[]];
}

export type BuiltinGatewayId = keyof typeof BUILTIN_GATEWAYS;
/** The built-in gateways' slugs, for the schemas that accept them. */
export const BUILTIN_GATEWAY_IDS = keysOf(BUILTIN_GATEWAYS);

export type GatewayKind = keyof typeof GATEWAY_KINDS;
/** The kinds organisations register gateways of, for the schemas that accept them. */
export const GATEWAY_KIND_IDS = keysOf(GATEWAY_KINDS);

export function isBuiltinGateway(gatewayId: string): gatewayId is BuiltinGatewayId {
  return Object.hasOwn(BUILTIN_GATEWAYS, gatewayId);
}

/** The provider of an organisation's gateways of this kind; `unsupported_gateway` if there is none. */
function gatewayKind(kind: string): OrganisationProvider {
  if (!Object.hasOwn(GATEWAY_KINDS, kind)) throw new ApiFailure('unsupported_gateway');
  // SAFETY: `kind` is one of GATEWAY_KINDS' own keys.
  return GATEWAY_KINDS[kind as GatewayKind];
}

/** A gateway's provider: its own if it is built in, otherwise its kind's; `unsupported_gateway` if it has none. */
export function gatewayProvider(gatewayId: string, kind: string): GatewayProvider {
  if (isBuiltinGateway(gatewayId)) return BUILTIN_GATEWAYS[gatewayId];
  return gatewayKind(kind);
}

/**
 * Refuses settings an organisation's gateway of this kind cannot be registered with (`invalid_settings`), or a kind
 * there is no provider for (`unsupported_gateway`), which only a gateway older than its kind's removal can have.
 */
export function checkGatewaySettings(kind: string, settings: Settings) {
  const provider = gatewayKind(kind);
  provider.checkSettings(settings);
}

/**
 * Releases what an organisation's gateway's provider made for it, once the gateway is removed, in the background: a
 * failure is logged, and leaves behind only what the provider would have released.
 */
export function retireGateway(organisationId: string, gatewayId: string, kind: string) {
  if (!Object.hasOwn(GATEWAY_KINDS, kind)) return;
  const provider = gatewayKind(kind);
  if (provider.retire === undefined) return;
  const environment = useEnvironment();
  const retiring = provider.retire({ organisationId, id: gatewayId }).catch(error => {
    console.warn(JSON.stringify({ event: 'gateway_retire_failed', gatewayId, kind, cause: String(error) }));
  });
  environment.background(retiring);
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
