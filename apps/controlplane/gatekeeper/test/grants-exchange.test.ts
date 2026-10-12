import { base64url, jwtVerify } from 'jose';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { GrantExchangeResultSchema } from './support/responses.ts';
import {
  CONSUMER_SUBJECT,
  decodePayload,
  exampleGrant,
  ISSUER,
  randomEndpointId,
  registration,
  signAssertion,
  signingKey,
  withPayload
} from './support/consumer.ts';
import { connectTestDatabase, startWorker, MOQ_KEY_ID } from './support/harness.ts';

const database = connectTestDatabase();
const worker = await startWorker();
const key = await signingKey();

beforeEach(async () => {
  await worker.restart({});
  await database.reset();
  worker.jwks.keys = [key.publicJwk];
  worker.jwks.requests = 0;
});

afterAll(async () => {
  await worker.close();
  await database.close();
});

const sign = (options: Omit<Parameters<typeof signAssertion>[0], 'key' | 'now'> = {}) =>
  signAssertion({ key, now: Date.now(), ...options });

async function expectError(response: Response, status: number, error: string) {
  expect({ status: response.status, body: await response.json() }).toMatchObject({ status, body: { error } });
  expect(response.headers.get('cache-control')).toBe('no-store');
}

describe('successful exchange', () => {
  it('issues a MoQ token and an Iroh lease for the signed grant', async () => {
    const grant = exampleGrant();
    const response = await worker.exchange(await sign({ grant }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
    const result = GrantExchangeResultSchema.parse(await response.json());
    expect(result.grant_id).toMatch(/^grt_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(result.subject).toBe(grant.subject);
    expect(Date.parse(result.expires_at) - Date.parse(result.issued_at)).toBe(300_000);
    expect(result.credentials.iroh).toEqual({
      endpoint_id: grant.requested_capabilities.iroh.endpoint_id,
      lease_id: expect.stringMatching(/^irl_/),
      expires_at: result.expires_at
    });
    expect(result.credentials.moq?.root).toBe('app-a/t_92/room_71');
  });

  it('signs a moq-relay token with the active control-plane key', async () => {
    // Verify with the configured secret's public half, then check the token carries only claims moq-relay knows.
    const response = await worker.exchange(await sign());
    const { credentials, grant_id } = GrantExchangeResultSchema.parse(await response.json());
    const { payload, protectedHeader } = await jwtVerify(credentials.moq?.token ?? '', worker.verificationKey);
    expect(protectedHeader).toEqual({ alg: 'ES256', kid: MOQ_KEY_ID, typ: 'JWT' });
    expect(payload).toEqual({
      root: 'app-a/t_92/room_71',
      publish: ['camera/**'],
      subscribe: [],
      iat: expect.any(Number),
      exp: expect.any(Number),
      jti: grant_id
    });
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(300);
  });

  it('publishes no signing keys', async () => {
    expect((await worker.request('/.well-known/jwks.json')).status).toBe(404);
    expect((await worker.request(`/moq/keys/${MOQ_KEY_ID}.jwk`)).status).toBe(404);
  });

  it('authorises the whole root with an empty path', async () => {
    const grant = exampleGrant();
    grant.requested_capabilities.moq.subscribe = [''];
    const response = await worker.exchange(await sign({ grant }));
    const { credentials } = GrantExchangeResultSchema.parse(await response.json());
    expect(decodePayload(credentials.moq?.token ?? '')).toMatchObject({ subscribe: ['**'] });
  });

  it('clamps the credential lifetime to the consumer and environment ceilings', async () => {
    const grant = { ...exampleGrant(), expires_in: 86_400 };
    const consumer = await worker.exchange(await sign({ grant }));
    const result = GrantExchangeResultSchema.parse(await consumer.json());
    expect(Date.parse(result.expires_at) - Date.parse(result.issued_at)).toBe(3_600_000);

    await worker.restart({ MAX_CREDENTIAL_LIFETIME_SECONDS: '120' });
    const environment = await worker.exchange(await sign({ grant: exampleGrant() }));
    const clamped = GrantExchangeResultSchema.parse(await environment.json());
    expect(Date.parse(clamped.expires_at) - Date.parse(clamped.issued_at)).toBe(120_000);
  });
});

describe('replay protection', () => {
  it('rejects a second exchange of the same assertion', async () => {
    const assertion = await sign();
    expect((await worker.exchange(assertion)).status).toBe(200);
    await expectError(await worker.exchange(assertion), 401, 'assertion_replayed');
  });

  it('issues credentials once when the same assertion is exchanged concurrently', async () => {
    const assertion = await sign();
    const responses = await Promise.all(Array.from({ length: 5 }, () => worker.exchange(assertion)));
    expect(responses.map(response => response.status).sort()).toEqual([200, 401, 401, 401, 401]);
  });

  it('does not consume an assertion whose request is rejected', async () => {
    const grant = exampleGrant();
    await worker.restart({ DENIED_IROH_ENDPOINTS: JSON.stringify([grant.requested_capabilities.iroh.endpoint_id]) });
    const assertion = await sign({ grant });
    await expectError(await worker.exchange(assertion), 403, 'invalid_endpoint_id');
    await worker.restart({});
    expect((await worker.exchange(assertion)).status).toBe(200);
  });
});

describe('request envelope', () => {
  const post = (body: string, contentType = 'application/json') =>
    worker.request('/grants/exchange', { method: 'POST', headers: { 'content-type': contentType }, body });

  it('rejects unsigned fields beside the assertion', async () => {
    const body = JSON.stringify({ grant_assertion: await sign(), grant: exampleGrant() });
    await expectError(await post(body), 400, 'invalid_request');
  });

  it('rejects duplicate members', async () => {
    const assertion = await sign();
    await expectError(await post(`{"grant_assertion":"${assertion}","grant_assertion":"x"}`), 400, 'invalid_request');
  });

  it('rejects non-JSON bodies', async () => {
    await expectError(await post(`grant_assertion=${await sign()}`, 'text/plain'), 400, 'invalid_request');
  });

  it('rejects an assertion that is not a compact JWS', async () => {
    await expectError(await worker.exchange('not-a-jwt'), 401, 'invalid_assertion');
  });

  it('rejects an unsigned assertion', async () => {
    const header = base64url.encode(JSON.stringify({ alg: 'none', kid: key.kid, typ: 'relay-grant+jwt' }));
    const payload = base64url.encode(JSON.stringify(decodePayload(await sign())));
    await expectError(await worker.exchange(`${header}.${payload}.`), 401, 'invalid_assertion');
    await expectError(await worker.exchange(`${header}.${payload}.AAAA`), 401, 'invalid_assertion');
  });
});

describe('protected header', () => {
  it.each([
    ['a token-supplied JWKS URL', { jku: 'https://attacker.example/jwks.json' }],
    ['a token-supplied certificate URL', { x5u: 'https://attacker.example/cert.pem' }],
    ['critical extensions', { crit: ['x-extension'], 'x-extension': 1 }]
  ])('rejects %s', async (_name, header) => {
    await expectError(await worker.exchange(await sign({ header })), 401, 'invalid_assertion');
  });

  it('rejects an embedded JWK', async () => {
    await expectError(
      await worker.exchange(await sign({ header: { jwk: { ...key.publicJwk } } })),
      401,
      'invalid_assertion'
    );
  });

  it('requires the registered token type', async () => {
    await expectError(await worker.exchange(await sign({ header: { typ: 'JWT' } })), 401, 'invalid_token_type');
  });

  it('only accepts registered algorithms', async () => {
    const p384 = await signingKey(key.kid, 'ES384');
    const assertion = await signAssertion({ key: p384, now: Date.now(), header: { alg: 'ES384' } });
    await expectError(await worker.exchange(assertion), 401, 'invalid_assertion');
  });
});

describe('consumer identity and keys', () => {
  it('rejects an unregistered issuer', async () => {
    const assertion = await sign({ claims: { iss: 'https://unknown.example' } });
    await expectError(await worker.exchange(assertion), 401, 'unknown_issuer');
  });

  it('rejects an unregistered consumer subject', async () => {
    await expectError(
      await worker.exchange(await sign({ claims: { sub: 'app-a-staging' } })),
      401,
      'unknown_principal'
    );
  });

  it('rejects a key the consumer does not publish', async () => {
    const other = await signingKey('app-a-unpublished');
    const assertion = await signAssertion({ key: other, now: Date.now() });
    await expectError(await worker.exchange(assertion), 401, 'unknown_key');
  });

  it('rejects a key revoked in the control plane even while it is still published', async () => {
    const consumer = registration();
    consumer.authentication.denied_key_ids = [key.kid];
    await worker.restart({ CONSUMER_REGISTRATIONS: JSON.stringify([consumer]) });
    await expectError(await worker.exchange(await sign()), 401, 'unknown_key');
  });

  it('rejects a published key that signed a different payload', async () => {
    const assertion = await sign();
    const tampered = withPayload(assertion, {
      ...decodePayload(assertion),
      grant: { ...exampleGrant(), expires_in: 3600 }
    });
    await expectError(await worker.exchange(tampered), 401, 'invalid_signature');
  });

  it('rejects a disabled consumer', async () => {
    await worker.restart({ CONSUMER_REGISTRATIONS: JSON.stringify([{ ...registration(), enabled: false }]) });
    await expectError(await worker.exchange(await sign()), 401, 'consumer_disabled');
  });
});

describe('registered claims', () => {
  const nowSeconds = () => Math.floor(Date.now() / 1000);

  it('requires the registered audience', async () => {
    const assertion = await sign({ claims: { aud: 'https://controlplane.example/other' } });
    await expectError(await worker.exchange(assertion), 401, 'invalid_audience');
  });

  it('rejects an expired assertion', async () => {
    const iat = nowSeconds() - 120;
    const assertion = await sign({ claims: { iat, nbf: iat, exp: iat + 60 } });
    await expectError(await worker.exchange(assertion), 401, 'assertion_expired');
  });

  it('rejects an assertion that is not yet valid', async () => {
    const iat = nowSeconds();
    const assertion = await sign({ claims: { iat, nbf: iat + 45, exp: iat + 60 } });
    await expectError(await worker.exchange(assertion), 401, 'assertion_not_yet_valid');
  });

  it('tolerates clock skew within the configured allowance', async () => {
    const iat = nowSeconds() + 20;
    expect((await worker.exchange(await sign({ claims: { iat, nbf: iat, exp: iat + 60 } }))).status).toBe(200);
  });

  it('rejects an assertion that outlives the registered maximum', async () => {
    const iat = nowSeconds();
    await expectError(await worker.exchange(await sign({ claims: { exp: iat + 600 } })), 401, 'invalid_assertion');
  });

  it.each([['jti'], ['nbf'], ['iat']])('requires %s', async claim => {
    await expectError(await worker.exchange(await sign({ claims: { [claim]: undefined } })), 401, 'invalid_assertion');
  });

  it('rejects unknown top-level claims', async () => {
    const assertion = await sign({ claims: { scope: 'admin' } });
    await expectError(await worker.exchange(assertion), 401, 'invalid_assertion');
  });

  it('identifies the registration by exact issuer, never a prefix', async () => {
    await expectError(await worker.exchange(await sign({ claims: { iss: `${ISSUER}/` } })), 401, 'unknown_issuer');
    expect(CONSUMER_SUBJECT).toBe(registration().authentication.subject);
  });
});

describe('signed grant schema', () => {
  it('rejects unsupported grant versions', async () => {
    const assertion = await sign({ grant: { ...exampleGrant(), version: 2 } });
    await expectError(await worker.exchange(assertion), 400, 'unsupported_grant_version');
  });

  it('rejects unknown grant fields', async () => {
    const grant = exampleGrant();
    const assertion = await sign({
      grant: { ...grant, requested_capabilities: { ...grant.requested_capabilities, admin: true } }
    });
    await expectError(await worker.exchange(assertion), 400, 'invalid_grant');
  });

  it.each(['app-a/../app-b', 'app-a//room', '/app-a', 'app-a/', 'app-a/*', 'app-a/room%2F71'])(
    'rejects the ambiguous root %s',
    async root => {
      const grant = exampleGrant();
      grant.requested_capabilities.moq.root = root;
      await expectError(await worker.exchange(await sign({ grant })), 400, 'invalid_grant');
    }
  );

  it.each(['..', '../camera', 'camera/..', './camera'])('rejects the escaping path %s', async path => {
    const grant = exampleGrant();
    grant.requested_capabilities.moq.publish = [path];
    await expectError(await worker.exchange(await sign({ grant })), 400, 'invalid_grant');
  });

  it('rejects a malformed endpoint ID', async () => {
    await expectError(await worker.exchange(await sign({ grant: exampleGrant('ABC') })), 400, 'invalid_grant');
  });

  it('rejects a grant without capabilities', async () => {
    const assertion = await sign({ grant: { ...exampleGrant(), requested_capabilities: {} } });
    await expectError(await worker.exchange(assertion), 400, 'invalid_grant');
  });
});

describe('delegation ceiling', () => {
  it.each(['app-b:user:1', 'app-ab:user:1', 'app-a', 'app-a:'])('rejects the subject %s', async subject => {
    const assertion = await sign({ grant: { ...exampleGrant(), subject } });
    await expectError(await worker.exchange(assertion), 403, 'invalid_subject');
  });

  it.each(['app-b/room_71', 'app-ab/room_71'])('rejects the MoQ root %s', async root => {
    const grant = exampleGrant();
    grant.requested_capabilities.moq.root = root;
    await expectError(await worker.exchange(await sign({ grant })), 403, 'invalid_resource');
  });

  it('rejects MoQ actions the consumer may not delegate', async () => {
    const consumer = registration();
    consumer.delegation.moq = { roots: ['app-a'], actions: ['subscribe'] };
    await worker.restart({ CONSUMER_REGISTRATIONS: JSON.stringify([consumer]) });
    await expectError(await worker.exchange(await sign()), 403, 'capability_not_delegated');
  });

  it('rejects Iroh access the consumer may not delegate', async () => {
    const consumer = registration();
    delete consumer.delegation.iroh;
    await worker.restart({ CONSUMER_REGISTRATIONS: JSON.stringify([consumer]) });
    await expectError(await worker.exchange(await sign()), 403, 'capability_not_delegated');
  });

  it('rejects an endpoint actively leased to another consumer', async () => {
    const endpointId = randomEndpointId();
    const other = registration();
    other.principal_id = 'app-b-production';
    other.authentication.issuer = 'https://api.app-b.example';
    other.delegation.subject_prefixes = ['app-b'];
    other.delegation.moq = { roots: ['app-b'], actions: ['publish', 'subscribe'] };
    await worker.restart({ CONSUMER_REGISTRATIONS: JSON.stringify([registration(), other]) });

    const grant = exampleGrant(endpointId);
    grant.subject = 'app-b:user:1';
    grant.requested_capabilities.moq.root = 'app-b/room';
    const first = await sign({ grant, claims: { iss: other.authentication.issuer } });
    expect((await worker.exchange(first)).status).toBe(200);
    await expectError(
      await worker.exchange(await sign({ grant: exampleGrant(endpointId) })),
      403,
      'invalid_endpoint_id'
    );
  });

  it('allows the same consumer to lease an endpoint again', async () => {
    const endpointId = randomEndpointId();
    expect((await worker.exchange(await sign({ grant: exampleGrant(endpointId) }))).status).toBe(200);
    expect((await worker.exchange(await sign({ grant: exampleGrant(endpointId) }))).status).toBe(200);
  });
});

describe('deployment configuration', () => {
  it('boots with the built registration defaults when no override is supplied', async () => {
    await worker.restart({ CONSUMER_REGISTRATIONS: undefined });
    expect((await worker.request('/health')).status).toBe(200);
  });

  it('accepts an explicit empty registration list and refuses all consumers', async () => {
    await worker.restart({ CONSUMER_REGISTRATIONS: '[]' });
    expect((await worker.request('/health')).status).toBe(200);
    await expectError(await worker.exchange(await sign()), 401, 'unknown_issuer');
    expect(worker.jwks.requests).toBe(0);
  });

  it.each([
    ['malformed JSON', '{'],
    ['an empty string', ''],
    ['a non-array', '{}'],
    ['an invalid registration', '[{}]'],
    ['duplicate registrations', JSON.stringify([registration(), registration()])],
    [
      'an unsafe JWKS URI',
      JSON.stringify([
        {
          ...registration(),
          authentication: { ...registration().authentication, jwks_uri: 'http://localhost/jwks' }
        }
      ])
    ]
  ])('fails closed for %s in CONSUMER_REGISTRATIONS', async (_name, value) => {
    await worker.restart({ CONSUMER_REGISTRATIONS: value });
    expect((await worker.exchange(await sign())).status).toBe(500);
    // An invalid configuration must not become a cached partial policy on subsequent requests.
    expect((await worker.exchange(await sign())).status).toBe(500);
    expect(worker.jwks.requests).toBe(0);
  });

  it('fails closed for an invalid endpoint denial list', async () => {
    await worker.restart({ DENIED_IROH_ENDPOINTS: '["invalid"]' });
    expect((await worker.request('/health')).status).toBe(500);
  });
});
