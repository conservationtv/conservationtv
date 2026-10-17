import { webcrypto } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { devices } from '../db/schema.ts';
import { ApiFailure } from '../errors.ts';
import type { UserPrincipal } from '../middleware/principal.ts';
import { organisationScope, trusted } from '../organisations/membership.ts';

// Every device has an identity from the moment it is created: an Ed25519 key pair, as an iroh endpoint's is. The
// public key travels as unpadded base64url; the public ID is derived exactly as iroh derives an endpoint ID, the 32
// public key bytes in lowercase hex. The private key is the 32-byte seed, iroh's `SecretKey`, encrypted at rest.

/** A new key pair for a device. */
export async function deviceIdentity() {
  // SAFETY: Ed25519 is an asymmetric algorithm, so generateKey resolves to a key pair.
  const pair = (await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
  const jwk = await webcrypto.subtle.exportKey('jwk', pair.privateKey);
  const publicKey = Buffer.from(jwk.x!, 'base64url');
  return {
    publicKey: jwk.x!,
    publicId: publicKey.toString('hex'),
    privateKey: new Uint8Array(Buffer.from(jwk.d!, 'base64url'))
  };
}

/**
 * A device's key pair, private key included, for an administrator of its organisation. Request sessions cannot read
 * private keys, so this is trusted code, after the same decision row-level security would make from the devices
 * table's roles: `not_found` if the principal cannot see its devices, `forbidden` unless they may edit them, which
 * only administrators may.
 */
export function deviceKeyPair(principal: UserPrincipal, organisationId: string, deviceId: string) {
  return trusted(async (tx, access) => {
    // Invisible devices are not found; visible ones the principal may not edit are forbidden.
    const decision = await access.inspect({ principal, resource: devices, scope: organisationScope(organisationId) });
    if (!decision.permissions.read?.allowed) throw new ApiFailure('not_found');
    if (!decision.permissions.edit?.allowed) throw new ApiFailure('forbidden');
    const [row] = await tx
      .select({ publicKey: devices.publicKey, publicId: devices.publicId, privateKey: devices.privateKey })
      .from(devices)
      .where(and(eq(devices.organisationId, organisationId), eq(devices.id, deviceId)));
    if (!row) throw new ApiFailure('not_found');
    return row;
  });
}
