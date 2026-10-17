import { importJWK } from 'jose';
import { z } from 'zod';

// The studio API is a gatekeeper consumer (apps/controlplane/gatekeeper): it signs `relay-grant+jwt` assertions with
// its own Ed25519 keys, and publishes their public halves at /.well-known/jwks.json, the `jwks_uri` gatekeeper has
// registered for it. To rotate, list the new key and make it active in one deploy: gatekeeper refetches the set when
// it meets an unknown `kid`. Drop the old key in a later deploy, once assertions signed with it have expired.

export const GRANT_SIGNING_ALGORITHM = 'EdDSA';

/** A private Ed25519 JWK, as WebCrypto exports one; members other than these are ignored. */
const PrivateSigningJwkSchema = z.object({
  kty: z.literal('OKP'),
  crv: z.literal('Ed25519'),
  kid: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  x: z.string(),
  d: z.string()
});
type PrivateSigningJwk = z.output<typeof PrivateSigningJwkSchema>;

/** The GRANT_SIGNING_KEYS secret: every key gatekeeper may still meet, and the one that signs new assertions. */
export const GrantSigningKeysSchema = z
  .strictObject({
    active_kid: z.string(),
    keys: z.array(PrivateSigningJwkSchema).nonempty()
  })
  .refine(set => set.keys.some(key => key.kid === set.active_kid), 'active_kid must name one of the listed keys')
  .refine(set => new Set(set.keys.map(key => key.kid)).size === set.keys.length, 'Key IDs must be unique');
export type GrantSigningKeys = z.output<typeof GrantSigningKeysSchema>;

export interface GrantSigner {
  kid: string;
  key: Awaited<ReturnType<typeof importJWK>>;
}

// Imported once per isolate, as the configuration is loaded once.
const signers = new WeakMap<GrantSigningKeys, Promise<GrantSigner>>();

/** The active key, ready to sign. */
export function grantSigner(keys: GrantSigningKeys): Promise<GrantSigner> {
  let signer = signers.get(keys);
  if (signer === undefined) {
    // SAFETY: the schema refuses a set whose active_kid names none of its keys.
    const active: PrivateSigningJwk = keys.keys.find(key => key.kid === keys.active_kid)!;
    signer = importJWK(active, GRANT_SIGNING_ALGORITHM).then(key => ({ kid: active.kid, key }));
    signers.set(keys, signer);
  }
  return signer;
}

/** The JWKS document: every listed key's public half, and never its private one. */
export function publishedKeys(keys: GrantSigningKeys | undefined) {
  const published = (keys?.keys ?? []).map(({ kid, x }) => ({
    kty: 'OKP' as const,
    crv: 'Ed25519' as const,
    x,
    kid,
    alg: GRANT_SIGNING_ALGORITHM,
    use: 'sig' as const
  }));
  return { keys: published };
}
