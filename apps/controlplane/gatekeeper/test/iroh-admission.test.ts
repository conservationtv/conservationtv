import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { grants } from '../src/db/schema.ts';
import { exampleGrant, randomEndpointId } from './support/consumer.ts';
import { connectTestDatabase, startWorker, RELAY_TOKEN } from './support/harness.ts';
import { GrantExchangeResultSchema } from './support/responses.ts';

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

async function lease(endpointId: string, expiresIn = 300) {
  const response = await worker.exchange({ ...exampleGrant(endpointId), expires_in: expiresIn });
  return GrantExchangeResultSchema.parse(await response.json());
}

async function admission(endpointId: string, token = RELAY_TOKEN, header = 'x-iroh-endpoint-id') {
  const response = await worker.request('/relays/iroh/admission', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, [header]: endpointId }
  });
  return { status: response.status, body: await response.text() };
}

describe('Iroh relay access callout', () => {
  it('admits an endpoint with an active lease', async () => {
    const endpointId = randomEndpointId();
    await lease(endpointId);
    expect(await admission(endpointId)).toEqual({ status: 200, body: 'true' });
  });

  it('accepts the deprecated X-Iroh-NodeId header', async () => {
    const endpointId = randomEndpointId();
    await lease(endpointId);
    expect(await admission(endpointId, RELAY_TOKEN, 'x-iroh-nodeid')).toEqual({ status: 200, body: 'true' });
  });

  it('refuses an endpoint without a lease', async () => {
    expect(await admission(randomEndpointId())).toEqual({ status: 403, body: 'false' });
  });

  it('refuses an unauthenticated relay', async () => {
    const endpointId = randomEndpointId();
    await lease(endpointId);
    expect(await admission(endpointId, 'wrong-token')).toEqual({ status: 401, body: 'false' });
    const anonymous = await worker.request('/relays/iroh/admission', {
      method: 'POST',
      headers: { 'x-iroh-endpoint-id': endpointId }
    });
    expect(anonymous.status).toBe(401);
  });

  it('refuses once the lease expires', async () => {
    const endpointId = randomEndpointId();
    await lease(endpointId, 2);
    expect((await admission(endpointId)).status).toBe(200);
    await expect.poll(async () => (await admission(endpointId)).status, { timeout: 5_000 }).toBe(403);
    expect(await admission(endpointId)).toEqual({ status: 403, body: 'false' });
  });

  it('refuses when the grant has been revoked', async () => {
    const endpointId = randomEndpointId();
    const { grant_id } = await lease(endpointId);
    await database.database.update(grants).set({ revokedAt: new Date() }).where(eq(grants.id, grant_id));
    expect(await admission(endpointId)).toEqual({ status: 403, body: 'false' });
  });

  it('refuses a denied endpoint despite an active lease', async () => {
    const endpointId = randomEndpointId();
    await lease(endpointId);
    await worker.restart({ DENIED_IROH_ENDPOINTS: JSON.stringify([endpointId]) });
    expect(await admission(endpointId)).toEqual({ status: 403, body: 'false' });
  });
});
