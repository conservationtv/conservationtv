import { SignJWT } from 'jose';
import type { MoqPath, MoqRelativePath } from '../grants/identifiers.ts';
import { useServices } from '../services.ts';
import { MOQ_SIGNING_ALGORITHM } from './keys.ts';

export interface MoqTokenClaims {
  grantId: string;
  root: MoqPath;
  publish: MoqRelativePath[];
  subscribe: MoqRelativePath[];
  issuedAt: number;
  expiresAt: number;
}

/** Each requested path authorises its whole subtree; the empty path authorises everything under the root. */
const pattern = (path: MoqRelativePath) => (path === '' ? '**' : `${path}/**`);

/**
 * A relay-native moq-relay token. moq-relay refuses tokens carrying claims it doesn't know, so this sets only `root`,
 * `publish`, `subscribe`, `iat`, `exp` and `jti` (the grant ID, which moq-relay reads and ignores). `sub` is omitted on
 * purpose: older moq-token releases read it as the subscribe list.
 */
export async function signMoqToken(claims: MoqTokenClaims): Promise<string> {
  const keyring = await useServices().moqKeys();
  return new SignJWT({
    root: claims.root,
    publish: claims.publish.map(pattern),
    subscribe: claims.subscribe.map(pattern)
  })
    .setProtectedHeader({ alg: MOQ_SIGNING_ALGORITHM, kid: keyring.activeKeyId, typ: 'JWT' })
    .setIssuedAt(claims.issuedAt)
    .setExpirationTime(claims.expiresAt)
    .setJti(claims.grantId)
    .sign(keyring.signingKey);
}
