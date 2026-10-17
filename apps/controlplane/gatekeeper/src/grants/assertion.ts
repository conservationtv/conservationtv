import { base64url, compactVerify, errors, importJWK } from 'jose';
import { z } from 'zod';
import type { ConsumerRegistration, ConsumerRegistrations } from '../config/schemas.ts';
import { AssertionAlgorithmSchema } from '../config/schemas.ts';
import { GrantError } from '../errors.ts';
import { type Json, parseStrictJson } from '@conservationtv/versioned-api/server';
import { useEnvironment } from '../env/env.ts';
import { consumerKey, type PublishedJwk } from './jwks.ts';

export const MAX_ASSERTION_LENGTH = 16_384;

const CompactJwsSchema = z
  .string()
  .max(MAX_ASSERTION_LENGTH)
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
export type CompactJws = z.output<typeof CompactJwsSchema>;

/**
 * Exactly `alg`, `kid` and `typ`. Anything else is refused: token-controlled key references (`jku`, `x5u`, `jwk`,
 * `x5c`), critical extensions (`crit`) and unencoded payloads (`b64`) included.
 */
const ProtectedHeaderSchema = z.strictObject({
  alg: z.string().min(1),
  kid: z.string().min(1).max(256),
  typ: z.string()
});
export type ProtectedHeader = z.output<typeof ProtectedHeaderSchema>;

/** Read before verification only to find a candidate registration; never used to authorise anything. */
const UnverifiedIdentitySchema = z.object({ iss: z.string(), sub: z.string() });
export type UnverifiedIdentity = z.output<typeof UnverifiedIdentitySchema>;

const NumericDateSchema = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
export type NumericDate = z.output<typeof NumericDateSchema>;

const AssertionClaimsSchema = z.strictObject({
  iss: z.string(),
  sub: z.string(),
  aud: z.string(),
  iat: NumericDateSchema,
  nbf: NumericDateSchema,
  exp: NumericDateSchema,
  jti: z.string().regex(/^[\x21-\x7e]{1,128}$/),
  grant: z.json()
});
export type AssertionClaims = z.output<typeof AssertionClaimsSchema>;

export interface AssertionEnvelope {
  token: string;
  header: ProtectedHeader;
  identity: UnverifiedIdentity;
}

export interface VerifiedAssertion {
  keyId: string;
  claims: AssertionClaims;
}

/** Decode one base64url JSON segment, strictly: valid UTF-8, valid JSON and no duplicate member names. */
function decodeSegment(segment: string): Json {
  try {
    return parseStrictJson(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(base64url.decode(segment))
    );
  } catch (error) {
    throw new GrantError('invalid_assertion', { cause: error });
  }
}

function parseSegment<Schema extends z.ZodType>(schema: Schema, segment: string): z.output<Schema> {
  const parsed = schema.safeParse(decodeSegment(segment));
  if (!parsed.success) throw new GrantError('invalid_assertion', { cause: parsed.error });
  return parsed.data;
}

/** Step 1: the assertion envelope. The signed `grant` is not looked at here. */
export function parseAssertion(token: string): AssertionEnvelope {
  if (!CompactJwsSchema.safeParse(token).success) throw new GrantError('invalid_assertion');
  const [header = '', payload = ''] = token.split('.');
  return {
    token,
    header: parseSegment(ProtectedHeaderSchema, header),
    identity: parseSegment(UnverifiedIdentitySchema, payload)
  };
}

/** Step 2: an exact issuer and subject match against registration, nothing looser. */
export function locateRegistration(
  registrations: ConsumerRegistrations,
  identity: UnverifiedIdentity
): ConsumerRegistration {
  const byIssuer = registrations.filter(registration => registration.authentication.issuer === identity.iss);
  if (byIssuer.length === 0) throw new GrantError('unknown_issuer');
  const registration = byIssuer.find(candidate => candidate.authentication.subject === identity.sub);
  if (!registration) throw new GrantError('unknown_principal');
  return registration;
}

/** Step 4: the algorithm and type come from registration; the header only has to agree with it. */
function checkHeader(registration: ConsumerRegistration, header: ProtectedHeader) {
  const { authentication } = registration;
  if (header.typ !== authentication.token_type) throw new GrantError('invalid_token_type');
  const algorithm = AssertionAlgorithmSchema.safeParse(header.alg);
  if (!algorithm.success || !authentication.allowed_algorithms.includes(algorithm.data)) {
    throw new GrantError('invalid_assertion');
  }
  if (authentication.denied_key_ids.includes(header.kid)) throw new GrantError('unknown_key');
  return algorithm.data;
}

/** Step 3: resolve the key from the registered JWKS only, and import it for exactly the registered algorithm. */
async function resolveKey(registration: ConsumerRegistration, header: ProtectedHeader, algorithm: string) {
  const jwk: PublishedJwk = await consumerKey(registration.authentication.jwks_uri, header.kid);
  if (jwk.alg !== undefined && jwk.alg !== algorithm) throw new GrantError('unknown_key');
  try {
    return await importJWK(jwk, algorithm);
  } catch (error) {
    throw new GrantError('unknown_key', { cause: error });
  }
}

async function verifySignature(token: string, key: Awaited<ReturnType<typeof importJWK>>, algorithm: string) {
  try {
    const { payload } = await compactVerify(token, key, { algorithms: [algorithm] });
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(payload);
  } catch (error) {
    if (error instanceof errors.JWSSignatureVerificationFailed) throw new GrantError('invalid_signature');
    throw new GrantError('invalid_assertion', { cause: error });
  }
}

/**
 * Step 5's time rules, all in whole seconds with the configured skew: issued no later than now, usable now, not yet
 * expired, ordered iat <= nbf < exp, and no longer-lived than the consumer's registered maximum.
 */
function checkTimes(registration: ConsumerRegistration, claims: AssertionClaims) {
  const now = Math.floor(useEnvironment().clock() / 1000);
  const skew = useEnvironment().policy.clockSkewSeconds;
  if (claims.nbf < claims.iat || claims.exp <= claims.nbf) throw new GrantError('invalid_assertion');
  if (claims.exp - claims.iat > registration.authentication.max_assertion_lifetime_seconds) {
    throw new GrantError('invalid_assertion');
  }
  if (claims.iat > now + skew || claims.nbf > now + skew) throw new GrantError('assertion_not_yet_valid');
  if (claims.exp <= now - skew) throw new GrantError('assertion_expired');
}

/** Steps 3 to 5. Returns claims only once the signature, registered claims and consumer status all check out. */
export async function verifyAssertion(
  registration: ConsumerRegistration,
  envelope: AssertionEnvelope
): Promise<VerifiedAssertion> {
  const algorithm = checkHeader(registration, envelope.header);
  const key = await resolveKey(registration, envelope.header, algorithm);
  const payload = await verifySignature(envelope.token, key, algorithm);
  const parsed = AssertionClaimsSchema.safeParse(decodeSignedPayload(payload));
  if (!parsed.success) throw new GrantError('invalid_assertion', { cause: parsed.error });
  const claims = parsed.data;
  const { authentication } = registration;
  if (claims.iss !== authentication.issuer || claims.sub !== authentication.subject) {
    throw new GrantError('invalid_assertion');
  }
  if (claims.aud !== authentication.audience) throw new GrantError('invalid_audience');
  checkTimes(registration, claims);
  if (!registration.enabled) throw new GrantError('consumer_disabled');
  return { keyId: envelope.header.kid, claims };
}

function decodeSignedPayload(payload: string): Json {
  try {
    return parseStrictJson(payload);
  } catch (error) {
    throw new GrantError('invalid_assertion', { cause: error });
  }
}
