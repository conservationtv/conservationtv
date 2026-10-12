import { eq, sql } from 'drizzle-orm';
import { jwksCache } from '../src/db/schema.ts';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { JWKS_URI, signAssertion, signingKey } from './support/consumer.ts';
import { connectTestDatabase, startWorker } from './support/harness.ts';

const database = connectTestDatabase();
const worker = await startWorker();
const key = await signingKey();

beforeEach(async () => {
  await worker.restart({});
  await database.reset();
  worker.jwks.keys = [key.publicJwk];
  worker.jwks.behaviour = 'serve';
  worker.jwks.maxAge = 300;
  worker.jwks.requests = 0;
});

afterAll(async () => {
  await worker.close();
  await database.close();
});

const exchange = async (signer = key) => worker.exchange(await signAssertion({ key: signer, now: Date.now() }));
// Arrange an older persisted cache and start a genuinely cold isolate, without changing the Worker's clock.
const ageCache = async (seconds: number) => {
  const milliseconds = seconds * 1000;
  await database.database
    .update(jwksCache)
    .set({
      fetchedAt: sql`${jwksCache.fetchedAt} - ${milliseconds} * interval '1 millisecond'`,
      freshUntil: sql`${jwksCache.freshUntil} - ${milliseconds} * interval '1 millisecond'`,
      staleUntil: sql`${jwksCache.staleUntil} - ${milliseconds} * interval '1 millisecond'`
    })
    .where(eq(jwksCache.jwksUri, JWKS_URI));
  await worker.restart();
};

describe('consumer JWKS retrieval', () => {
  it('validates from cached keys without a request per exchange', async () => {
    expect((await exchange()).status).toBe(200);
    expect((await exchange()).status).toBe(200);
    expect(worker.jwks.requests).toBe(1);
  });

  it('shares persisted keys with a cold isolate', async () => {
    expect((await exchange()).status).toBe(200);
    await worker.restart();
    expect((await exchange()).status).toBe(200);
    expect(worker.jwks.requests).toBe(1);
  });

  it.each([
    [10, 60],
    [7200, 3600]
  ])('bounds max-age %i to %i seconds', async (maxAge, lifetime) => {
    worker.jwks.maxAge = maxAge;
    expect((await exchange()).status).toBe(200);
    await ageCache(lifetime - 10);
    expect((await exchange()).status).toBe(200);
    expect(worker.jwks.requests).toBe(1);
    await ageCache(11);
    expect((await exchange()).status).toBe(200);
    expect(worker.jwks.requests).toBe(2);
  });

  it('keeps using cached keys through a short outage, then fails closed', async () => {
    expect((await exchange()).status).toBe(200);
    worker.jwks.behaviour = 'fail';
    await ageCache(400);
    expect((await exchange()).status).toBe(200);
    await ageCache(3600);
    const response = await exchange();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'relay_unavailable' });
  });

  it('refreshes once for a newly rotated key', async () => {
    expect((await exchange()).status).toBe(200);
    const rotated = await signingKey('app-a-2026-08');
    worker.jwks.keys = [key.publicJwk, rotated.publicJwk];
    await ageCache(31);
    expect((await exchange(rotated)).status).toBe(200);
    expect(worker.jwks.requests).toBe(2);
  });

  it('rate-limits refreshes triggered by unknown key IDs', async () => {
    expect((await exchange()).status).toBe(200);
    const unknown = await signingKey('app-a-unknown');
    worker.jwks.behaviour = 'fail';
    await ageCache(31);
    expect((await exchange(unknown)).status).toBe(401);
    expect((await exchange(unknown)).status).toBe(401);
    expect(worker.jwks.requests).toBe(2);
  });

  it.each([
    ['a redirect', 'redirect'],
    ['an oversized document', 'oversized'],
    ['private key material', 'private']
  ] as const)('refuses %s', async (_name, behaviour) => {
    worker.jwks.behaviour = behaviour;
    const response = await exchange();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'relay_unavailable' });
  });
});
