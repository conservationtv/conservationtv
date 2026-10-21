import { parseStrictJson } from '@conservationtv/versioned-api/server';
import { exportJWK, importJWK, type JWK } from 'jose';
import { z } from 'zod';

// The keys this API signs gateway tokens with, for gateways that verify them against its published JWKS
// (`GET /gateway-keys`) rather than asking it: MediaMTX, by `authMethod: jwt`. Gateways fetch the JWKS once and keep
// it, so a new key reaches them only when they restart: list it beside the old one first, restart the gateways, then
// make it active, and drop the old key once its longest-lived token has expired.

export const GATEWAY_SIGNING_ALGORITHM = 'ES256';

const PrivateSigningJwkSchema = z.strictObject({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  alg: z.literal(GATEWAY_SIGNING_ALGORITHM),
  use: z.literal('sig').optional(),
  kid: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  x: z.string(),
  y: z.string(),
  d: z.string()
});
export type PrivateSigningJwk = z.output<typeof PrivateSigningJwkSchema>;

/** The GATEWAY_SIGNING_KEYS secret: every key gateways should accept, and which one signs new tokens. */
export const GatewaySigningKeysSchema = z
  .strictObject({
    active_kid: z.string(),
    keys: z.array(PrivateSigningJwkSchema).nonempty()
  })
  .refine(set => set.keys.some(key => key.kid === set.active_kid), 'active_kid must name one of the listed keys')
  .refine(set => new Set(set.keys.map(key => key.kid)).size === set.keys.length, 'Key IDs must be unique');
export type GatewaySigningKeys = z.output<typeof GatewaySigningKeysSchema>;

export type SigningKey = Awaited<ReturnType<typeof importJWK>>;

export interface GatewayKeyring {
  activeKeyId: string;
  signingKey: SigningKey;
  /** Every listed key's public half, as the JWKS publishes it. */
  publicKeys: JWK[];
}

export async function loadGatewayKeyring(secret: string): Promise<GatewayKeyring> {
  const set = GatewaySigningKeysSchema.parse(parseStrictJson(secret));
  const active = set.keys.find(key => key.kid === set.active_kid)!;
  const publicKeys = await Promise.all(
    set.keys.map(async ({ kid, x, y }) => {
      const key = await importJWK({ kty: 'EC', crv: 'P-256', x, y }, GATEWAY_SIGNING_ALGORITHM);
      const jwk = await exportJWK(key);
      return { ...jwk, kid, alg: GATEWAY_SIGNING_ALGORITHM, use: 'sig' };
    })
  );
  return {
    activeKeyId: active.kid,
    signingKey: await importJWK(active, GATEWAY_SIGNING_ALGORITHM),
    publicKeys
  };
}
