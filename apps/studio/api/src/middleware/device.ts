import { createStore } from '@conservationtv/store';
import { device as devicePrincipal, type Principal } from '@conservationtv/umbrella';
import { eq } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { verifySignature, webcrypto, isSignatureError, type Verifier } from 'http-message-sig';
import { verifyContentDigest } from 'httpbis-digest-headers';
import { useCache } from '../cache/cache.ts';
import { devices } from '../db/schema.ts';
import { ApiFailure } from '../errors.ts';
import { trusted } from '../organisations/membership.ts';
import { useServices } from '../services.ts';
import type { DeviceKind } from '../topology/device-kinds.ts';
import { grantDevice } from '../topology/device-principals.ts';

// Devices authenticate with their own identity (src/topology/identity.ts): each request carries an RFC 9421 HTTP
// Message Signature by the device's Ed25519 key, named by its public ID as `keyid`. The signature must cover the
// method, the URL and an RFC 9530 `Content-Digest` of the body (of empty content, for a request without one), and the
// content type when there is one, with `created`, `expires` and a `nonce`. The body must match the signed digest, and
// each nonce is accepted once (src/cache/cache.ts), within a minute of signing. Every failure is `invalid_signature`.

/** The device a request was signed by. */
export interface AuthenticatedDevice {
  id: string;
  organisationId: string;
  kind: DeviceKind;
  principal: Principal<string, 'device'>;
}

export const [withDevice, useDevice] = createStore<AuthenticatedDevice>('device');

/** How old a signature may be, and how far clocks may disagree, in seconds. */
const MAX_AGE_SECONDS = 60;
const CLOCK_SKEW_SECONDS = 5;

/** How long a device's principal grant is trusted to be in place before it is ensured again. */
const GRANT_CHECK_SECONDS = 60 * 60;

/** A verifier for the device a signature names, carrying that device. */
interface DeviceVerifier extends Verifier {
  device: AuthenticatedDevice;
}

/** The device with this public ID, and a verifier for its key; `invalid_signature` if there is none. */
async function deviceVerifier(publicId: string | undefined): Promise<DeviceVerifier> {
  if (publicId === undefined) throw new ApiFailure('invalid_signature');
  const [row] = await trusted(tx =>
    tx
      .select({
        id: devices.id,
        organisationId: devices.organisationId,
        kind: devices.kind,
        publicKey: devices.publicKey
      })
      .from(devices)
      .where(eq(devices.publicId, publicId))
  );
  if (!row) throw new ApiFailure('invalid_signature');
  const key = await crypto.subtle.importKey('raw', Buffer.from(row.publicKey, 'base64url'), 'Ed25519', false, [
    'verify'
  ]);
  const verifier = webcrypto.verifier(key);
  const principal = devicePrincipal(row.id);
  return {
    ...verifier,
    device: { id: row.id, organisationId: row.organisationId, kind: row.kind, principal }
  };
}

/** The verified signature over the request, by a known device. */
async function verifiedSignature(request: Request, components: readonly string[]) {
  const services = useServices();
  const now = Math.floor(services.clock() / 1000);
  try {
    return await verifySignature<DeviceVerifier>(request, {
      policy: {
        algorithms: ['ed25519'],
        requiredComponents: [
          '@method',
          '@target-uri',
          'content-digest',
          ...(request.headers.has('content-type') ? ['content-type'] : []),
          ...components
        ],
        requiredParameters: ['keyid', 'created', 'expires', 'nonce'],
        maxAge: MAX_AGE_SECONDS,
        clockSkew: CLOCK_SKEW_SECONDS,
        now
      },
      resolveVerifier: candidate => deviceVerifier(candidate.parameters.keyid)
    });
  } catch (error) {
    if (isSignatureError(error)) throw new ApiFailure('invalid_signature', { cause: error });
    throw error;
  }
}

/** Whether the request body is what the signed `Content-Digest` describes. */
async function bodyMatchesDigest(body: ArrayBuffer, digest: string) {
  // The digest library accepts an empty dictionary as matching anything.
  if (digest.trim() === '') return false;
  try {
    return await verifyContentDigest(body, digest);
  } catch {
    return false;
  }
}

/** Ensure the device's principal grant now and then: it should exist from creation, and this heals one that does not. */
async function ensureGrant(device: AuthenticatedDevice) {
  const cache = useCache();
  const key = `device-grant:${device.id}`;
  if ((await cache.get(key)) !== null) return;
  await trusted((_tx, access) => grantDevice(access, device.organisationId, device.id));
  await cache.put(key, '1', GRANT_CHECK_SECONDS);
}

/**
 * Require a device's signature on the request (see above); `components` are further headers it must cover, such as
 * `idempotency-key`. Downstream, `useDevice()` is the device.
 */
export const requireDevice = (components: readonly string[] = []) =>
  createMiddleware(async (c, next) => {
    const signature = await verifiedSignature(c.req.raw, components);
    const { device } = signature.verifier;
    // The signature covers the digest, so it is present; the body is cached for the handler.
    const body = await c.req.arrayBuffer();
    if (!(await bodyMatchesDigest(body, c.req.header('content-digest') ?? '')))
      throw new ApiFailure('invalid_signature');
    // Only after everything else holds, so a rejected request cannot spend a nonce.
    const cache = useCache();
    const fresh = await cache.add(
      `nonce:${device.id}:${signature.parameters.nonce}`,
      '1',
      MAX_AGE_SECONDS + CLOCK_SKEW_SECONDS + 1
    );
    if (!fresh) throw new ApiFailure('invalid_signature');
    await ensureGrant(device);
    await withDevice(device, next);
  });
