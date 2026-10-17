import { eq } from 'drizzle-orm';
import { base64url, decodeProtectedHeader, jwtVerify } from 'jose';
import { z } from 'zod';
import { grants } from '../db/schema.ts';
import { MoqPathSchema } from '../grants/identifiers.ts';
import { parseStrictJson } from '@conservationtv/versioned-api/server';
import { MOQ_SIGNING_ALGORITHM } from '../moq/keys.ts';
import { isSubtreePattern, ScopeError, scopeToDialedPath } from '../moq/scope.ts';
import { useEnvironment } from '../env/env.ts';
import { matchesSecret } from './secrets.ts';

/** How often moq-relay re-asks about a live session, so a revoked grant closes its sessions within this bound. */
export const MOQ_REVALIDATE_SECONDS = 60;

/**
 * How long a peer session outlives gatekeeper being unreachable. Each revalidation extends it, so it bounds only an
 * outage; moq-auth requires a revalidated grant to carry an expiry.
 */
export const MOQ_CLUSTER_GRANT_SECONDS = 24 * 60 * 60;

/** moq-transport Token Type 0: an opaque cluster secret or consumer JWT negotiated out of band. */
const OUT_OF_BAND_TOKEN = 0;

// The parts of moq-auth's `Request` (moq-relay 0.17) this callout reads. The relay may add fields; they're ignored.
const SetupTokenSchema = z.object({ kind: z.int().nonnegative(), value: z.string() });
export type SetupToken = z.output<typeof SetupTokenSchema>;

const MoqAuthRequestSchema = z.object({
  id: z.string().min(1),
  node: z.string(),
  event: z.enum(['connect', 'revalidate', 'end']),
  transport: z.string(),
  path: z.string(),
  query: z.string().nullish(),
  token: SetupTokenSchema.nullish()
});
export type MoqAuthRequest = z.output<typeof MoqAuthRequestSchema>;

const SubtreePatternSchema = z.string().refine(isSubtreePattern);
export type SubtreePattern = z.output<typeof SubtreePatternSchema>;

/** Exactly the claims `signMoqToken` sets; moq-relay's own token rules would refuse anything more. */
const MoqTokenClaimsSchema = z.strictObject({
  root: MoqPathSchema,
  publish: z.array(SubtreePatternSchema),
  subscribe: z.array(SubtreePatternSchema),
  iat: z.int(),
  exp: z.int(),
  jti: z.string()
});
export type MoqTokenClaims = z.output<typeof MoqTokenClaimsSchema>;

/** moq-auth's `Grant`: patterns relative to the dialed path, an absolute expiry and a revalidation cadence. */
export interface MoqGrant {
  publish: string[];
  subscribe: string[];
  expires: number;
  revalidate: number;
  tier: string;
  peer?: boolean;
}

export interface MoqGranted {
  outcome: 'granted';
  grant: MoqGrant;
}
export interface MoqRefused {
  outcome: 'refused';
  reason: string;
}
export interface MoqNoted {
  outcome: 'noted' | 'unauthenticated' | 'malformed';
}
export type MoqAdmission = MoqGranted | MoqRefused | MoqNoted;

class Refusal extends Error {}

/** The password in HTTP Basic credentials, or undefined if they are absent or malformed. */
function basicPassword(authorization: string | undefined): string | undefined {
  const encoded = /^Basic ([A-Za-z0-9+/]+=*)$/.exec(authorization ?? '')?.[1];
  if (!encoded) return undefined;
  try {
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
    const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    const separator = decoded.indexOf(':');
    return separator === -1 ? undefined : decoded.slice(separator + 1);
  } catch {
    return undefined;
  }
}

/** moq-relay sends its auth URL's userinfo as HTTP Basic credentials; the password is the shared relay key. */
const isRelayToken = (authorization: string | undefined) =>
  matchesSecret(basicPassword(authorization), useEnvironment().variables.MOQ_RELAY_TOKEN);

/** The body as a moq-auth request, or undefined if it isn't strict JSON of that shape. */
function moqAuthRequest(body: string): MoqAuthRequest | undefined {
  try {
    return MoqAuthRequestSchema.parse(parseStrictJson(body));
  } catch {
    return undefined;
  }
}

/** The last non-empty `jwt` query parameter, as `moq auth serve` reads it. */
function queryToken(query: string | null | undefined): string | undefined {
  return new URLSearchParams(query ?? '')
    .getAll('jwt')
    .filter(jwt => jwt !== '')
    .at(-1);
}

/**
 * The credential a session presents: in its SETUP (type 0 only) or as `?jwt=`. Both may be present only if they agree, so a
 * session can't be judged on one credential while presenting another.
 */
function sessionToken(request: MoqAuthRequest): string {
  const query = queryToken(request.query);
  if (!request.token) {
    if (query === undefined) throw new Refusal('no token was presented');
    return query;
  }
  if (request.token.kind !== OUT_OF_BAND_TOKEN) throw new Refusal('unsupported SETUP token type');
  const setup = decodeSetupToken(request.token.value);
  if (query !== undefined && query !== setup) throw new Refusal('the SETUP token and ?jwt= disagree');
  return setup;
}

function decodeSetupToken(value: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(base64url.decode(value));
  } catch (error) {
    throw new Refusal('invalid SETUP token encoding', { cause: error });
  }
}

/** A token gatekeeper signed, with any key still in the keyring, that has not expired. */
async function verifiedClaims(token: string): Promise<MoqTokenClaims> {
  try {
    const { kid } = decodeProtectedHeader(token);
    const key = kid === undefined ? undefined : (await useEnvironment().moqKeys()).verificationKeys.get(kid);
    if (!key) throw new Refusal('the token was not signed by a control-plane key');
    const { payload } = await jwtVerify(token, key, {
      algorithms: [MOQ_SIGNING_ALGORITHM],
      typ: 'JWT',
      currentDate: new Date(useEnvironment().clock())
    });
    return MoqTokenClaimsSchema.parse(payload);
  } catch (error) {
    throw error instanceof Refusal ? error : new Refusal('the token is invalid or expired', { cause: error });
  }
}

/** The grant behind the token must still stand: recorded, unrevoked, unexpired, and its consumer still enabled. */
async function grantingPrincipal(claims: MoqTokenClaims): Promise<string> {
  const db = await useEnvironment().database();
  const [grant] = await db
    .select({ principalId: grants.principalId, revokedAt: grants.revokedAt, expiresAt: grants.expiresAt })
    .from(grants)
    .where(eq(grants.id, claims.jti))
    .limit(1);
  if (!grant || grant.revokedAt !== null) throw new Refusal('the grant is unknown or revoked');
  if (grant.expiresAt.getTime() <= useEnvironment().clock()) throw new Refusal('the grant has expired');
  const consumer = useEnvironment().policy.consumers.find(candidate => candidate.principal_id === grant.principalId);
  if (!consumer?.enabled) throw new Refusal('the consumer is no longer enabled');
  return grant.principalId;
}

/** Shared cluster credentials grant only root peer sessions, never public HTTP or scoped consumer sessions. */
function clusterGrant(request: MoqAuthRequest): MoqGrant {
  if (request.path !== '/' || !['quic', 'websocket'].includes(request.transport))
    throw new Refusal('cluster credentials require a root peer session');
  return {
    publish: ['**'],
    subscribe: ['**'],
    expires: Math.floor(useEnvironment().clock() / 1000) + MOQ_CLUSTER_GRANT_SECONDS,
    revalidate: MOQ_REVALIDATE_SECONDS,
    tier: 'cluster',
    peer: true
  };
}

// The shared secret authorizes cluster peers; consumer JWTs retain their recorded, scoped grants.
async function decide(request: MoqAuthRequest): Promise<MoqGrant> {
  const token = sessionToken(request);
  if (await matchesSecret(token, useEnvironment().variables.MOQ_CLUSTER_TOKEN)) return clusterGrant(request);
  const claims = await verifiedClaims(token);
  const principalId = await grantingPrincipal(claims);
  try {
    const permissions = scopeToDialedPath(claims.root, claims, request.path);
    return {
      ...permissions,
      expires: claims.exp,
      revalidate: MOQ_REVALIDATE_SECONDS,
      tier: principalId
    };
  } catch (error) {
    throw error instanceof ScopeError ? new Refusal(error.message) : error;
  }
}

/**
 * moq-relay's `--auth-url` callout. Cluster sessions present the shared peer secret; consumer tokens are verified
 * against the control plane's keys and their recorded grants on connect and revalidation.
 * `end` is acknowledged. The relay itself authenticates every callback with the shared relay key.
 */
export async function admitMoqSession(authorization: string | undefined, body: string): Promise<MoqAdmission> {
  if (!(await isRelayToken(authorization))) return { outcome: 'unauthenticated' };
  const request = moqAuthRequest(body);
  if (!request) return { outcome: 'malformed' };
  if (request.event === 'end') return { outcome: 'noted' };
  try {
    return { outcome: 'granted', grant: await decide(request) };
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return { outcome: 'refused', reason: error.message };
  }
}
