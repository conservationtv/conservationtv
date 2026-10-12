import { importJWK } from 'jose';
import { z } from 'zod';
import { parseStrictJson } from '../json.ts';

export const MOQ_SIGNING_ALGORITHM = 'ES256';

const PrivateSigningJwkSchema = z.strictObject({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  alg: z.literal(MOQ_SIGNING_ALGORITHM),
  use: z.literal('sig').optional(),
  kid: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  x: z.string(),
  y: z.string(),
  d: z.string()
});
export type PrivateSigningJwk = z.output<typeof PrivateSigningJwkSchema>;

/**
 * The MOQ_SIGNING_KEYS secret. Only gatekeeper signs and verifies these consumer tokens. Keep old keys in the
 * keyring until their longest-lived token expires; switch active_kid to choose the key for new tokens.
 */
export const MoqSigningKeysSchema = z
  .strictObject({
    active_kid: z.string(),
    keys: z.array(PrivateSigningJwkSchema).nonempty()
  })
  .refine(set => set.keys.some(key => key.kid === set.active_kid), 'active_kid must name one of the listed keys')
  .refine(set => new Set(set.keys.map(key => key.kid)).size === set.keys.length, 'Key IDs must be unique');
export type MoqSigningKeys = z.output<typeof MoqSigningKeysSchema>;

export type SigningKey = Awaited<ReturnType<typeof importJWK>>;

export interface MoqKeyring {
  activeKeyId: string;
  signingKey: SigningKey;
  /**
   * Every listed key's public half, by `kid`, so tokens signed before a rotation still verify. Only the control plane
   * verifies them (as moq-relay's auth server); no key is ever published.
   */
  verificationKeys: Map<string, SigningKey>;
}

export async function loadMoqKeyring(secret: string): Promise<MoqKeyring> {
  const set = MoqSigningKeysSchema.parse(parseStrictJson(secret));
  const active = set.keys.find(key => key.kid === set.active_kid);
  if (!active) throw new Error('active_kid must name one of the listed keys');
  return {
    activeKeyId: active.kid,
    signingKey: await importJWK(active, MOQ_SIGNING_ALGORITHM),
    verificationKeys: new Map(
      await Promise.all(
        set.keys.map(async ({ kid, x, y }) => {
          const key = await importJWK({ kty: 'EC', crv: 'P-256', x, y }, MOQ_SIGNING_ALGORITHM);
          return [kid, key] as const;
        })
      )
    )
  };
}
