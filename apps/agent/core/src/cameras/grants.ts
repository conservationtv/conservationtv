import {
  CAMERA_GRANT_ALGORITHM,
  CAMERA_GRANT_CLAIM,
  CameraGrantSchema,
  type CameraGrant
} from '@conservationtv/cameras';
import type { DeviceIdentity } from '@conservationtv/studio-sdk';
import { createLocalJWKSet, jwtVerify } from 'jose';

// Checking the grants that admit commands to the agent's cameras (`@conservationtv/cameras`, grants.ts). The studio API
// signs each with this agent's own identity, as it does the gateway's tokens (gateway/streams/auth.ts), so the agent
// checks it against its own public key and fetches nothing. A grant is for one device, named as its subject: the peer
// that presents it must be that device, which the connection already proved.

/** A grant that admits nothing here: missing, forged, expired, another agent's, or presented by another device. */
export class GrantRefused extends Error {
  constructor(reason: string) {
    super(`The grant does not admit this: ${reason}`);
    this.name = 'GrantRefused';
  }
}

/** A grant that checked out: what it admits, for whom, and until when. */
export interface Admitted {
  grant: CameraGrant;
  /** The endpoint ID of the device it was given to, which presented it. */
  holder: string;
  /** Its own ID, by which one admitting a single command is told from a second use of itself. */
  id: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/** What a grant is checked against. */
export interface GrantCheck {
  /** Who signs grants: the studio API's URL. */
  issuer: string;
  /** The agent's own identity, which they are signed as and issued for. */
  identity: DeviceIdentity;
  /** The endpoint ID of the peer presenting it. */
  peer: string;
}

/** The grant the token carries, checked: `GrantRefused` otherwise. */
export async function verifyGrant(token: string | undefined, check: GrantCheck): Promise<Admitted> {
  if (token === undefined || token === '') throw new GrantRefused('none was presented');
  const { issuer, identity, peer } = check;
  const keys = createLocalJWKSet({ keys: [identity.publicJwk] });
  const verified = await jwtVerify(token, keys, {
    issuer,
    audience: identity.publicId,
    algorithms: [CAMERA_GRANT_ALGORITHM]
  }).catch(() => {
    throw new GrantRefused('it is not one the studio signed for this agent, or it has expired');
  });
  const { sub, jti, exp } = verified.payload;
  if (sub !== peer) throw new GrantRefused('it was given to another device');
  const grant = CameraGrantSchema.safeParse(verified.payload[CAMERA_GRANT_CLAIM]);
  if (!grant.success || jti === undefined || exp === undefined) throw new GrantRefused('it is malformed');
  return { grant: grant.data, holder: peer, id: jti, expiresAt: exp * 1000 };
}
