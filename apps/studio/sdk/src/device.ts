import type { Authenticate } from '@conservationtv/versioned-api/client';
import { appendSignature, createSignature, webcrypto } from 'http-message-sig';
import { createContentDigestHeader } from 'httpbis-digest-headers';

// Acting as a device, the way the studio API's device operations (`reports.submit`, `irohSessions.create`) require: an
// RFC 9421 HTTP Message Signature by the device's Ed25519 identity, named by its public ID, over the method, the URL,
// an RFC 9530 `Content-Digest` of the body and its content type, with `created`, `expires` and a single-use `nonce`.

/** How long a signature is valid for: the API accepts signatures up to a minute old. */
const LIFETIME_SECONDS = 60;

/** PKCS #8's wrapping of a raw Ed25519 seed, which WebCrypto imports where it cannot import the seed alone. */
const PKCS8_ED25519_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20
]);

function hex(bytes: Uint8Array) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function fromBase64url(text: string) {
  const base64 = text.replaceAll('-', '+').replaceAll('_', '/');
  return Uint8Array.from(atob(base64), character => character.charCodeAt(0));
}

/** A device's identity: its Ed25519 key pair, as the studio API and iroh both know it. */
export class DeviceIdentity {
  /** The 32-byte seed: what iroh calls the endpoint's secret key. */
  readonly secretKey: Uint8Array;
  /** The public key in lowercase hex: the device's public ID, and its iroh endpoint ID. */
  readonly publicId: string;
  private readonly signingKey: CryptoKey;

  private constructor(secretKey: Uint8Array, publicId: string, signingKey: CryptoKey) {
    this.secretKey = secretKey;
    this.publicId = publicId;
    this.signingKey = signingKey;
  }

  /** The identity whose 32-byte Ed25519 seed is `secretKey`. */
  static async fromSecretKey(secretKey: Uint8Array): Promise<DeviceIdentity> {
    if (secretKey.length !== 32) throw new Error('A device secret key is 32 bytes');
    const pkcs8 = new Uint8Array([...PKCS8_ED25519_PREFIX, ...secretKey]);
    const signingKey = await crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', true, ['sign']);
    const jwk = await crypto.subtle.exportKey('jwk', signingKey);
    const publicId = hex(fromBase64url(jwk.x!));
    return new DeviceIdentity(secretKey, publicId, signingKey);
  }

  /** The request with its body's digest and this device's signature over it. */
  async sign(request: Request): Promise<Request> {
    const body = await request.arrayBuffer();
    const content = body.byteLength === 0 ? null : body;
    const headers = new Headers(request.headers);
    headers.set('content-digest', await createContentDigestHeader(body, ['SHA-256']));
    const digested = new Request(request, { method: request.method, headers, body: content });
    const created = Math.floor(Date.now() / 1000);
    const signature = await createSignature(digested, {
      components: [
        '@method',
        '@target-uri',
        'content-digest',
        ...(headers.has('content-type') ? ['content-type'] : [])
      ],
      parameters: { keyid: this.publicId, created, expires: created + LIFETIME_SECONDS, nonce: crypto.randomUUID() },
      signer: webcrypto.signer(this.signingKey)
    });
    // A copy of the headers, with the signature fields added.
    const signed = appendSignature(headers, signature);
    return new Request(request, { method: request.method, headers: signed, body: content });
  }
}

/** Authenticate as the device: sign every request with its identity. */
export function deviceSignature(identity: DeviceIdentity): Authenticate {
  return request => identity.sign(request);
}
