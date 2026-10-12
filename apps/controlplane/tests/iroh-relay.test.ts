import type { Grant } from '@conservationtv/controlplane-sdk';
import { exampleGrant, grants, RELAY_TOKEN } from '@conservationtv/gatekeeper/testing';
import { Endpoint, presetMinimal, RelayMode, SecretKey } from '@number0/iroh';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type GatekeeperServer, startGatekeeper } from './support/gatekeeper.ts';
import { type StartedRelay, startIrohRelay } from './support/relays.ts';

// A real iroh endpoint homes on the relay container. The relay asks gatekeeper about it on connect; the endpoint comes
// online only if gatekeeper holds an active lease for its endpoint ID, and keeps retrying (and failing) otherwise.

/** How long a refused endpoint is given to (not) come online; admitted ones connect in well under a second. */
const REFUSAL_WINDOW_MS = 5_000;

const gatekeeper: GatekeeperServer = await startGatekeeper();
const relay: StartedRelay = await startIrohRelay(gatekeeper, RELAY_TOKEN);
/** A relay configured with the wrong bearer token, as a misconfigured or impersonating relay would be. */
const impostor: StartedRelay = await startIrohRelay(gatekeeper, 'not-the-relay-token');
const endpoints: Endpoint[] = [];

afterAll(async () => {
  await impostor.stop();
  await relay.stop();
  await gatekeeper.stop();
});

beforeEach(async () => {
  await gatekeeper.reset();
});

afterEach(async () => {
  await Promise.all(endpoints.splice(0).map(endpoint => endpoint.close()));
});

const endpointIdOf = (secret: SecretKey) => Buffer.from(secret.public().toBytes()).toString('hex');

const lease = (secret: SecretKey): Promise<Grant> => gatekeeper.exchange(exampleGrant(endpointIdOf(secret)));

/** Bind an endpoint with `secret` whose only relay is `relayUrl`, without n0 discovery or relays. */
async function bindEndpoint(secret: SecretKey, relayUrl = relay.url): Promise<Endpoint> {
  const builder = Endpoint.builder();
  presetMinimal(builder);
  builder.secretKey(secret.toBytes());
  builder.relayMode(RelayMode.customFromUrls([relayUrl]));
  const endpoint = await builder.bind();
  endpoints.push(endpoint);
  return endpoint;
}

async function comesOnline(endpoint: Endpoint): Promise<boolean> {
  const window = new Promise<boolean>(resolve => setTimeout(() => resolve(false), REFUSAL_WINDOW_MS));
  return Promise.race([endpoint.online().then(() => true), window]);
}

const calloutsFor = (secret: SecretKey) =>
  gatekeeper.callouts.filter(callout => callout.headers.get('x-iroh-nodeid') === endpointIdOf(secret));

describe('iroh-relay access callout', () => {
  it('admits an endpoint holding an active lease', async () => {
    const secret = SecretKey.generate();
    await lease(secret);
    expect(await comesOnline(await bindEndpoint(secret))).toBe(true);
    expect(calloutsFor(secret)).toEqual([expect.objectContaining({ path: '/relays/iroh/admission', status: 200 })]);
  });

  it('authenticates itself with the configured bearer token', async () => {
    const secret = SecretKey.generate();
    await lease(secret);
    await comesOnline(await bindEndpoint(secret));
    expect(calloutsFor(secret)[0]?.headers.get('authorization')).toBe(`Bearer ${RELAY_TOKEN}`);
  });

  it('refuses an endpoint without a lease', async () => {
    const secret = SecretKey.generate();
    expect(await comesOnline(await bindEndpoint(secret))).toBe(false);
    expect(calloutsFor(secret).length).toBeGreaterThan(0);
    expect(calloutsFor(secret).every(callout => callout.status === 403)).toBe(true);
  });

  it('refuses an endpoint whose grant has been revoked', async () => {
    const secret = SecretKey.generate();
    const { grant_id } = await lease(secret);
    await gatekeeper.database.database.update(grants).set({ revokedAt: new Date() }).where(eq(grants.id, grant_id));
    expect(await comesOnline(await bindEndpoint(secret))).toBe(false);
  });

  it('refuses an endpoint whose lease has expired', async () => {
    const secret = SecretKey.generate();
    const { expires_at } = await gatekeeper.exchange({ ...exampleGrant(endpointIdOf(secret)), expires_in: 1 });
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(expires_at) - Date.now()) + 50));
    expect(await comesOnline(await bindEndpoint(secret))).toBe(false);
  });

  it('admits an endpoint leased after its first refusal, on the relay retrying', async () => {
    const secret = SecretKey.generate();
    const endpoint = await bindEndpoint(secret);
    await expect.poll(() => calloutsFor(secret).length, { timeout: REFUSAL_WINDOW_MS }).toBeGreaterThan(0);
    await lease(secret);
    await expect(endpoint.online()).resolves.toBeUndefined();
    expect(
      calloutsFor(secret)
        .map(callout => callout.status)
        .at(-1)
    ).toBe(200);
  });
});

describe('iroh-relay presenting the wrong bearer token', () => {
  it('is refused even for a leased endpoint', async () => {
    const secret = SecretKey.generate();
    await lease(secret);
    expect(await comesOnline(await bindEndpoint(secret, impostor.url))).toBe(false);
    expect(calloutsFor(secret).every(callout => callout.status === 401)).toBe(true);
  });
});
