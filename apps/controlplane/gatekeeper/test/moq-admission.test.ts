import { eq } from 'drizzle-orm';
import { base64url, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { grants } from '../src/db/schema.ts';
import { type SetupToken } from '../src/relays/moq.ts';
import { exampleGrant } from './support/consumer.ts';
import { connectTestDatabase, startWorker, MOQ_KEY_ID, MOQ_RELAY_TOKEN, MOQ_CLUSTER_TOKEN } from './support/harness.ts';
import { MOQ_CLUSTER_GRANT_SECONDS } from '../src/relays/moq.ts';
import { type GrantExchangeResult, GrantExchangeResultSchema } from './support/responses.ts';

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

async function exchange(expiresIn = 300): Promise<GrantExchangeResult> {
  const response = await worker.exchange({ ...exampleGrant(), expires_in: expiresIn });
  return GrantExchangeResultSchema.parse(await response.json());
}

async function moqToken(expiresIn = 300): Promise<string> {
  const { credentials } = await exchange(expiresIn);
  return credentials.moq?.token ?? '';
}

interface SessionEvent {
  event?: 'connect' | 'revalidate' | 'end';
  path: string;
  query?: string;
  token?: SetupToken;
}

/** The Authorization header moq-relay derives from `https://moq-relay:<key>@…` userinfo. */
const basic = (password: string, username = 'moq-relay') => `Basic ${btoa(`${username}:${password}`)}`;
const RELAY_AUTHORIZATION = basic(MOQ_RELAY_TOKEN);

/** POST a moq-auth request exactly as moq-relay 0.17 does. */
async function admission(session: SessionEvent, authorization: string | undefined = RELAY_AUTHORIZATION) {
  const body = { id: '00ff', event: 'connect', node: 'relay-1', transport: 'quic', ...session };
  if (body.event === 'end') Object.assign(body, { reason: 'closed', duration: 1.5, bytes: { sent: 0, received: 0 } });
  const headers = new Headers({ 'content-type': 'application/json' });
  if (authorization) headers.set('authorization', authorization);
  const response = await worker.request('/relays/moq/admission', {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  return { status: response.status, body: response.status === 204 ? undefined : await response.json() };
}

describe('MoQ relay auth callout', () => {
  it('grants the token at its root, bounded by its expiry and revalidated', async () => {
    const token = await moqToken();
    const result = await admission({ path: '/app-a/t_92/room_71', query: `jwt=${token}` });
    expect(result).toEqual({
      status: 200,
      body: {
        publish: ['camera/**'],
        subscribe: [],
        expires: expect.any(Number),
        revalidate: 60,
        tier: 'consumer'
      }
    });
  });

  it('reads a type 0 SETUP token', async () => {
    const value = base64url.encode(await moqToken());
    const result = await admission({ path: '/app-a/t_92/room_71', token: { kind: 0, value } });
    expect(result.status).toBe(200);
  });

  it.each([
    ['beneath the root, inside a pattern', '/app-a/t_92/room_71/camera', ['**']],
    ['above the root', '/app-a', ['t_92/room_71/camera/**']],
    ['at the root with surrounding slashes', '/app-a/t_92/room_71/', ['camera/**']]
  ])('scopes patterns to a path %s', async (_name, path, publish) => {
    const result = await admission({ path, query: `jwt=${await moqToken()}` });
    expect(result).toMatchObject({ status: 200, body: { publish } });
  });

  it.each([
    ['beside the root', '/app-b/room'],
    ['beneath the root where nothing is granted', '/app-a/t_92/room_71/screen'],
    ['that is not canonical', '/app-a/t_92/../room_71']
  ])('refuses a path %s', async (_name, path) => {
    const result = await admission({ path, query: `jwt=${await moqToken()}` });
    expect(result).toMatchObject({ status: 403, body: { error: 'access_denied' } });
  });

  it('refuses a session without a token', async () => {
    expect((await admission({ path: '/app-a/t_92/room_71' })).status).toBe(403);
  });

  it('refuses a SETUP token and ?jwt= that disagree', async () => {
    const [first, second] = [await moqToken(), await moqToken()];
    const token = { kind: 0, value: base64url.encode(first) };
    expect((await admission({ path: '/app-a/t_92/room_71', query: `jwt=${second}`, token })).status).toBe(403);
  });

  it('refuses malformed SETUP and JWT encodings', async () => {
    expect((await admission({ path: '/', token: { kind: 0, value: '%%%' } })).status).toBe(403);
    expect((await admission({ path: '/', query: 'jwt=invalid' })).status).toBe(403);
  });

  it('refuses token types other than out-of-band', async () => {
    const token = { kind: 1, value: base64url.encode(await moqToken()) };
    expect((await admission({ path: '/app-a/t_92/room_71', token })).status).toBe(403);
  });

  it('refuses a token the control plane did not sign', async () => {
    const { privateKey } = await generateKeyPair('ES256');
    const now = Math.floor(Date.now() / 1000);
    const forged = await new SignJWT({ root: 'app-a', publish: ['**'], subscribe: ['**'] })
      .setProtectedHeader({ alg: 'ES256', kid: MOQ_KEY_ID, typ: 'JWT' })
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .setJti('grt_forged')
      .sign(privateKey);
    expect((await admission({ path: '/app-a', query: `jwt=${forged}` })).status).toBe(403);
  });

  it('refuses an expired token on revalidation', async () => {
    const token = await moqToken(2);
    const session = { event: 'revalidate' as const, path: '/app-a/t_92/room_71', query: `jwt=${token}` };
    expect((await admission(session)).status).toBe(200);
    await expect.poll(async () => (await admission(session)).status, { timeout: 5_000 }).toBe(403);
  });

  it('closes sessions of a revoked grant at revalidation', async () => {
    const { grant_id, credentials } = await exchange();
    const session = {
      event: 'revalidate' as const,
      path: '/app-a/t_92/room_71',
      query: `jwt=${credentials.moq?.token}`
    };
    expect((await admission(session)).status).toBe(200);
    await database.database.update(grants).set({ revokedAt: new Date() }).where(eq(grants.id, grant_id));
    expect((await admission(session)).status).toBe(403);
  });

  it('accepts any username but requires the relay key as the Basic password', async () => {
    const session = { path: '/app-a/t_92/room_71', query: `jwt=${await moqToken()}` };
    expect((await admission(session, basic(MOQ_RELAY_TOKEN, 'relay-2'))).status).toBe(200);
    for (const authorization of [
      '',
      basic('wrong'),
      basic(''),
      `Bearer ${MOQ_RELAY_TOKEN}`,
      `Basic ${btoa(MOQ_RELAY_TOKEN)}`,
      'Basic %%%'
    ])
      expect((await admission(session, authorization)).status).toBe(401);
    await worker.restart({ MOQ_RELAY_TOKEN: '' });
    expect((await admission(session, basic(''))).status).toBe(401);
  });

  it('acknowledges the end of a session', async () => {
    expect(await admission({ event: 'end', path: '/app-a/t_92/room_71' })).toEqual({ status: 204, body: undefined });
  });

  it('rejects requests that are not moq-auth requests', async () => {
    const response = await worker.request('/relays/moq/admission', {
      method: 'POST',
      headers: { authorization: RELAY_AUTHORIZATION },
      body: '{"event":"connect"}'
    });
    expect(response.status).toBe(400);
  });
});

describe('MoQ shared cluster credential without a node registry', () => {
  async function peerAdmission(overrides = {}, authorization: string = RELAY_AUTHORIZATION) {
    return worker.request('/relays/moq/admission', {
      method: 'POST',
      headers: { authorization },
      body: JSON.stringify({
        id: 'peer',
        node: 'unregistered-receiver',
        event: 'connect',
        transport: 'quic',
        path: '/',
        query: `jwt=${MOQ_CLUSTER_TOKEN}`,
        ...overrides
      })
    });
  }

  it('admits the shared credential on connect and revalidation', async () => {
    for (const event of ['connect', 'revalidate']) {
      const response = await peerAdmission({ event });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        publish: ['**'],
        subscribe: ['**'],
        peer: true,
        tier: 'cluster',
        expires: expect.any(Number),
        revalidate: 60
      });
    }
  });

  it('accepts the same opaque credential in a type 0 SETUP token and on WebSocket peers', async () => {
    expect(
      (await peerAdmission({ query: undefined, token: { kind: 0, value: base64url.encode(MOQ_CLUSTER_TOKEN) } })).status
    ).toBe(200);
    expect((await peerAdmission({ transport: 'websocket' })).status).toBe(200);
  });

  it('bounds the grant to outlast a gatekeeper outage by a fixed window', async () => {
    const before = Math.floor(Date.now() / 1000);
    const { expires } = z.object({ expires: z.number() }).parse(await (await peerAdmission()).json());
    expect(expires).toBeGreaterThanOrEqual(before + MOQ_CLUSTER_GRANT_SECONDS);
    expect(expires).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + MOQ_CLUSTER_GRANT_SECONDS);
  });

  it('refuses missing, incorrect and unconfigured secrets', async () => {
    for (const query of [undefined, 'jwt=', 'jwt=wrong', `jwt=${MOQ_CLUSTER_TOKEN.slice(0, -1)}d`]) {
      expect((await peerAdmission({ query })).status).toBe(403);
    }
    await worker.restart({ MOQ_CLUSTER_TOKEN: '' });
    expect((await peerAdmission()).status).toBe(403);
  });

  it('requires the relay key even with the correct cluster credential', async () => {
    for (const authorization of ['', basic('wrong'), basic(MOQ_CLUSTER_TOKEN)])
      expect((await peerAdmission({}, authorization)).status).toBe(401);
  });

  it('rejects the old secret on revalidation after rotation', async () => {
    expect((await peerAdmission()).status).toBe(200);
    const rotated = 'd'.repeat(64);
    await worker.restart({ MOQ_CLUSTER_TOKEN: rotated });
    expect((await peerAdmission({ event: 'revalidate' })).status).toBe(403);
    expect((await peerAdmission({ query: `jwt=${rotated}` })).status).toBe(200);
  });

  it('never grants peer privileges from client certificate facts in the request', async () => {
    const tls = {
      name: 'peer',
      fingerprint: 'd'.repeat(64),
      issuer: 'Any CA',
      expires: Math.floor(Date.now() / 1000) + 600
    };
    expect((await peerAdmission({ query: undefined, tls })).status).toBe(403);
  });

  it('refuses conflicting credentials and non-peer uses of the shared secret', async () => {
    expect((await peerAdmission({ token: { kind: 0, value: base64url.encode('wrong') } })).status).toBe(403);
    for (const overrides of [{ path: '/app-a' }, { transport: 'http' }, { transport: 'iroh' }]) {
      expect((await peerAdmission(overrides)).status).toBe(403);
    }
  });

  it('keeps consumer tokens scoped and does not grant peer privileges', async () => {
    const response = await peerAdmission({ query: `jwt=${await moqToken()}` });
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty('peer');
  });

  it('does not expose dynamic peer discovery', async () => {
    expect(
      (await worker.request('/relays/moq/peers', { headers: { authorization: RELAY_AUTHORIZATION } })).status
    ).toBe(404);
  });
});
