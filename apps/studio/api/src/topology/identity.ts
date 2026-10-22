import { webcrypto } from 'node:crypto';

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
