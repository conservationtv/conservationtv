/** A gateway every organisation can deliver to, defined here rather than stored: always on the internet. */
export interface BuiltinGateway {
  name: string;
  kind: string;
  protocols: readonly string[];
}

/**
 * The built-in gateways, by the slug that is their ID. Where each one is (its URLs and credentials) belongs to the
 * deployment, not to this catalogue. Removing one that exposures still use strands them: migrate them first.
 */
export const BUILTIN_GATEWAY_IDS = ['conservationtv', 'cloudflare'] as const;
export type BuiltinGatewayId = (typeof BUILTIN_GATEWAY_IDS)[number];
export const BUILTIN_GATEWAYS = {
  conservationtv: { name: 'conservation.tv', kind: 'moq-relay', protocols: ['moq'] },
  cloudflare: { name: 'Cloudflare', kind: 'cloudflare-realtime', protocols: ['webrtc'] }
} as const satisfies Record<BuiltinGatewayId, BuiltinGateway>;

export function isBuiltinGateway(gatewayId: string): gatewayId is BuiltinGatewayId {
  return Object.hasOwn(BUILTIN_GATEWAYS, gatewayId);
}

/** The built-in gateways as the gateway routes return them, beside an organisation's own. */
export const builtinGateways = BUILTIN_GATEWAY_IDS.map(id => ({
  id,
  builtin: true,
  ...BUILTIN_GATEWAYS[id],
  networkId: null,
  settings: {},
  createdAt: null
}));
