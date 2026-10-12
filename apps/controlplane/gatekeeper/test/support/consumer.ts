import {
  base64url,
  type CompactJWSHeaderParameters,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTPayload,
  SignJWT
} from 'jose';
import type { ConsumerRegistrationInput } from '../../src/config/schemas.ts';

export const ISSUER = 'https://api.app-a.example';
export const JWKS_URI = 'https://api.app-a.example/.well-known/jwks.json';
export const AUDIENCE = 'https://controlplane.example/grants/exchange';
export const CONSUMER_SUBJECT = 'app-a-production';
export const KEY_ID = 'app-a-2026-07';

export function registration(): ConsumerRegistrationInput {
  return {
    principal_id: 'app-a-production',
    authentication: {
      method: 'federated_jwt',
      issuer: ISSUER,
      jwks_uri: JWKS_URI,
      audience: AUDIENCE,
      subject: CONSUMER_SUBJECT,
      allowed_algorithms: ['ES256'],
      max_assertion_lifetime_seconds: 60
    },
    delegation: {
      subject_prefixes: ['app-a'],
      moq: { roots: ['app-a'], actions: ['publish', 'subscribe'] },
      iroh: { actions: ['connect'] },
      max_credential_lifetime_seconds: 3600
    },
    enabled: true
  };
}

export const randomEndpointId = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');

/** The end-to-end example grant from the specification, with a fresh endpoint. */
export function exampleGrant(endpointId = randomEndpointId()) {
  const subscribe: string[] = [];
  return {
    version: 1,
    subject: 'app-a:user:opaque-8f83d2',
    requested_capabilities: {
      moq: { root: 'app-a/t_92/room_71', publish: ['camera'], subscribe },
      iroh: { endpoint_id: endpointId, action: 'connect' }
    },
    expires_in: 300
  };
}
export type ExampleGrant = ReturnType<typeof exampleGrant>;

export interface SigningKey {
  kid: string;
  privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  publicJwk: JWK;
}

export async function signingKey(kid = KEY_ID, algorithm = 'ES256'): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair(algorithm);
  return { kid, privateKey, publicJwk: { ...(await exportJWK(publicKey)), kid, alg: algorithm, use: 'sig' } };
}

export interface AssertionOptions {
  key: SigningKey;
  grant?: JWTPayload['grant'];
  /** Replaces or adds protected header parameters. */
  header?: Partial<CompactJWSHeaderParameters>;
  /** Replaces or adds payload claims; `undefined` removes one. */
  claims?: JWTPayload;
  now: number;
}

/** A consumer-signed `relay-grant+jwt`, valid by default, with every part overridable for negative tests. */
export async function signAssertion(options: AssertionOptions): Promise<string> {
  const iat = Math.floor(options.now / 1000);
  const payload: JWTPayload = {
    iss: ISSUER,
    sub: CONSUMER_SUBJECT,
    aud: AUDIENCE,
    iat,
    nbf: iat,
    exp: iat + 60,
    jti: crypto.randomUUID(),
    grant: options.grant ?? exampleGrant(),
    ...options.claims
  };
  // Let jose emit whatever critical extensions a test declares, so the control plane is what refuses them.
  const crit = Object.fromEntries((options.header?.crit ?? []).map(name => [name, true]));
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'ES256', kid: options.key.kid, typ: 'relay-grant+jwt', ...options.header })
    .sign(options.key.privateKey, { crit });
}

/** Swap a token's payload without re-signing it. */
export function withPayload(token: string, payload: JWTPayload): string {
  const [header, , signature] = token.split('.');
  return `${header}.${base64url.encode(JSON.stringify(payload))}.${signature}`;
}

export function decodePayload(token: string): JWTPayload {
  const [, payload = ''] = token.split('.');
  return JSON.parse(new TextDecoder().decode(base64url.decode(payload)));
}
