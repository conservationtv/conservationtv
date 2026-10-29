import { eq } from 'drizzle-orm';
import { jwtVerify } from 'jose';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { GrantExchangeResultSchema } from './support/responses.ts';
import { decodePayload, exampleGrant, randomEndpointId } from './support/consumer.ts';
import { grants } from '../src/db/schema.ts';
import { connectTestDatabase, CONSUMER_TOKEN, MOQ_KEY_ID, OTHER_CONSUMER, startWorker } from './support/harness.ts';

const database = connectTestDatabase();
const worker = await startWorker();

beforeEach(async () => {
  await worker.restart({});
  await database.reset();
});

afterAll(async () => {
  await worker.close();
  await database.close();
});

async function expectError(response: Response, status: number, error: string) {
  expect({ status: response.status, body: await response.json() }).toMatchObject({ status, body: { error } });
  expect(response.headers.get('cache-control')).toBe('no-store');
}

describe('successful exchange', () => {
  it('issues a MoQ token and an Iroh lease for the grant', async () => {
    const grant = exampleGrant();
    const response = await worker.exchange(grant);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
    const result = GrantExchangeResultSchema.parse(await response.json());
    expect(result.grant_id).toMatch(/^grt_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(result.subject).toBe(grant.subject);
    expect(Date.parse(result.expires_at) - Date.parse(result.issued_at)).toBe(300_000);
    expect(result.credentials.iroh).toEqual({
      relay: 'http://localhost:3340/',
      endpoint_id: grant.requested_capabilities.iroh.endpoint_id,
      lease_id: expect.stringMatching(/^irl_/),
      expires_at: result.expires_at
    });
    expect(result.credentials.moq?.root).toBe('test/app-a/t_92/room_71');
    expect(result.credentials.moq?.relay).toBe('https://localhost:4433/');
  });

  it('signs a moq-relay token with the active control-plane key', async () => {
    // Verify with the configured secret's public half, then check the token carries only claims moq-relay knows.
    const response = await worker.exchange(exampleGrant());
    const { credentials, grant_id } = GrantExchangeResultSchema.parse(await response.json());
    const { payload, protectedHeader } = await jwtVerify(credentials.moq?.token ?? '', worker.verificationKey);
    expect(protectedHeader).toEqual({ alg: 'ES256', kid: MOQ_KEY_ID, typ: 'JWT' });
    expect(payload).toEqual({
      root: 'test/app-a/t_92/room_71',
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
    const response = await worker.exchange(grant);
    const { credentials } = GrantExchangeResultSchema.parse(await response.json());
    expect(decodePayload(credentials.moq?.token ?? '')).toMatchObject({ subscribe: ['**'] });
  });

  it('clamps the credential lifetime to the environment ceiling', async () => {
    const grant = { ...exampleGrant(), expires_in: 86_400 };
    const response = await worker.exchange(grant);
    const result = GrantExchangeResultSchema.parse(await response.json());
    expect(Date.parse(result.expires_at) - Date.parse(result.issued_at)).toBe(3_600_000);

    await worker.restart({ MAX_CREDENTIAL_LIFETIME_SECONDS: '120' });
    const clamped = GrantExchangeResultSchema.parse(await (await worker.exchange(exampleGrant())).json());
    expect(Date.parse(clamped.expires_at) - Date.parse(clamped.issued_at)).toBe(120_000);
  });

  it("places each consumer's root beneath its namespace, and records it", async () => {
    const response = await worker.exchange(exampleGrant(), OTHER_CONSUMER.token);
    const { credentials, grant_id } = GrantExchangeResultSchema.parse(await response.json());
    expect(credentials.moq?.root).toBe('other/app-a/t_92/room_71');
    expect(decodePayload(credentials.moq?.token ?? '')).toMatchObject({ root: 'other/app-a/t_92/room_71' });
    const [audited] = await database.database
      .select({ namespace: grants.namespace, moqRoot: grants.moqRoot })
      .from(grants)
      .where(eq(grants.id, grant_id));
    expect(audited).toEqual({ namespace: 'other', moqRoot: 'other/app-a/t_92/room_71' });
  });

  it('leases the same endpoint again', async () => {
    const endpointId = randomEndpointId();
    expect((await worker.exchange(exampleGrant(endpointId))).status).toBe(200);
    expect((await worker.exchange(exampleGrant(endpointId))).status).toBe(200);
  });
});

describe('consumer authentication', () => {
  it('requires the consumer token', async () => {
    await expectError(await worker.exchange(exampleGrant(), undefined), 401, 'invalid_token');
    await expectError(await worker.exchange(exampleGrant(), 'wrong-token'), 401, 'invalid_token');
    await expectError(await worker.exchange(exampleGrant(), `${CONSUMER_TOKEN}x`), 401, 'invalid_token');
  });

  it('refuses a token in any other scheme', async () => {
    const response = await worker.request('/grants/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${CONSUMER_TOKEN}` },
      body: JSON.stringify(exampleGrant())
    });
    await expectError(response, 401, 'invalid_token');
  });

  it('refuses every exchange while no consumer is configured', async () => {
    await worker.restart({ CONSUMERS: '[]' });
    await expectError(await worker.exchange(exampleGrant(), ''), 401, 'invalid_token');
  });

  it('authenticates before reading the body', async () => {
    await expectError(await worker.exchange('not a grant', 'wrong-token'), 401, 'invalid_token');
  });
});

describe('request envelope', () => {
  const post = (body: string, contentType = 'application/json') =>
    worker.request('/grants/exchange', {
      method: 'POST',
      headers: { 'content-type': contentType, authorization: `Bearer ${CONSUMER_TOKEN}` },
      body
    });

  it('rejects duplicate members', async () => {
    const body = JSON.stringify(exampleGrant()).replace('{', '{"expires_in":60,');
    await expectError(await post(body), 400, 'invalid_request');
  });

  it('rejects non-JSON bodies', async () => {
    await expectError(await post(JSON.stringify(exampleGrant()), 'text/plain'), 400, 'invalid_request');
  });
});

describe('grant schema', () => {
  it('rejects unknown grant fields', async () => {
    await expectError(await worker.exchange({ ...exampleGrant(), version: 1 }), 400, 'invalid_request');
    const grant = exampleGrant();
    const unknown = { ...grant, requested_capabilities: { ...grant.requested_capabilities, admin: true } };
    await expectError(await worker.exchange(unknown), 400, 'invalid_request');
  });

  it.each(['app-a/../app-b', 'app-a//room', '/app-a', 'app-a/', 'app-a/*', 'app-a/room%2F71'])(
    'rejects the ambiguous root %s',
    async root => {
      const grant = exampleGrant();
      grant.requested_capabilities.moq.root = root;
      await expectError(await worker.exchange(grant), 400, 'invalid_request');
    }
  );

  it.each(['..', '../camera', 'camera/..', './camera'])('rejects the escaping path %s', async path => {
    const grant = exampleGrant();
    grant.requested_capabilities.moq.publish = [path];
    await expectError(await worker.exchange(grant), 400, 'invalid_request');
  });

  it('rejects a malformed endpoint ID', async () => {
    await expectError(await worker.exchange(exampleGrant('ABC')), 400, 'invalid_request');
  });

  it('rejects a grant without capabilities', async () => {
    await expectError(await worker.exchange({ ...exampleGrant(), requested_capabilities: {} }), 400, 'invalid_request');
  });

  it('rejects a root too long to place beneath a namespace', async () => {
    const grant = exampleGrant();
    grant.requested_capabilities.moq.root = Array.from({ length: 16 }, () => 'a').join('/');
    await expectError(await worker.exchange(grant), 400, 'invalid_request');
  });

  it('rejects a subject with spaces', async () => {
    await expectError(await worker.exchange({ ...exampleGrant(), subject: 'app a' }), 400, 'invalid_request');
  });
});

describe('denied endpoints', () => {
  it('refuses to lease a denied endpoint, and records nothing', async () => {
    const grant = exampleGrant();
    await worker.restart({ DENIED_IROH_ENDPOINTS: JSON.stringify([grant.requested_capabilities.iroh.endpoint_id]) });
    await expectError(await worker.exchange(grant), 403, 'invalid_endpoint_id');
    const audited = await database.database.execute('select count(*)::int as count from grants');
    expect(audited.rows).toEqual([{ count: 0 }]);
  });
});

describe('deployment configuration', () => {
  it('boots with the built defaults when no override is supplied', async () => {
    await worker.restart({ DENIED_IROH_ENDPOINTS: undefined });
    expect((await worker.request('/health')).status).toBe(200);
    expect((await worker.exchange(exampleGrant())).status).toBe(200);
  });

  it.each([
    ['malformed JSON', '{'],
    ['an empty string', ''],
    ['an invalid endpoint', '["invalid"]']
  ])('fails closed for %s in DENIED_IROH_ENDPOINTS', async (_name, value) => {
    await worker.restart({ DENIED_IROH_ENDPOINTS: value });
    expect((await worker.exchange(exampleGrant())).status).toBe(500);
    // An invalid configuration must not become a cached partial policy on subsequent requests.
    expect((await worker.request('/health')).status).toBe(500);
  });

  it.each([
    [
      'a duplicate namespace',
      [
        { namespace: 'test', token: 'a' },
        { namespace: 'test', token: 'b' }
      ]
    ],
    [
      'a duplicate token',
      [
        { namespace: 'test', token: 'a' },
        { namespace: 'other', token: 'a' }
      ]
    ],
    ['a namespace that is not one segment', [{ namespace: 'test/nested', token: 'a' }]],
    ['an empty token', [{ namespace: 'test', token: '' }]]
  ])('fails closed for %s in CONSUMERS', async (_name, consumers) => {
    await worker.restart({ CONSUMERS: JSON.stringify(consumers) });
    expect((await worker.request('/health')).status).toBe(500);
  });
});
