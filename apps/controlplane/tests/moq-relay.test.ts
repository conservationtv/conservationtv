import type { Grant } from '@conservationtv/controlplane-sdk';
import { exampleGrant, grants, MOQ_CLUSTER_TOKEN } from '@conservationtv/gatekeeper/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { type GatekeeperServer, startGatekeeper } from './support/gatekeeper.ts';
import { type StartedRelay, startMoqRelay, startMoqPeers } from './support/relays.ts';

// moq-relay asks gatekeeper about every session. Its one-shot HTTP routes (`/announced`) are sessions too, so a plain
// HTTP client drives the full callout: relay → gatekeeper → grant or refusal → relay's answer to the client.

const ROOM = 'app-a/t_92/room_71';

const gatekeeper: GatekeeperServer = await startGatekeeper();
const relay: StartedRelay = await startMoqRelay(gatekeeper);
/** A relay presenting the wrong relay key on its callbacks. */
const impostor: StartedRelay = await startMoqRelay(gatekeeper, 'f'.repeat(64));
afterAll(async () => {
  await impostor.stop();
  await relay.stop();
  await gatekeeper.stop();
});

beforeEach(async () => {
  await gatekeeper.reset();
});

/** Exchange a grant that may subscribe to the whole room, which `/announced` needs. */
function issueGrant(): Promise<Grant> {
  const grant = exampleGrant();
  grant.requested_capabilities.moq.subscribe = [''];
  return gatekeeper.exchange(grant);
}

const announced = (path: string, token?: string) =>
  fetch(`${relay.url}/announced/${path}${token === undefined ? '' : `?jwt=${token}`}`);

const connects = () => gatekeeper.callouts.filter(callout => JSON.parse(callout.body).event === 'connect');

describe('moq-relay auth callout', () => {
  it('admits a session presenting a gatekeeper-issued token', async () => {
    const { credentials } = await issueGrant();
    const response = await announced(ROOM, credentials.moq?.token);
    expect(response.status).toBe(200);
    expect(connects()).toEqual([expect.objectContaining({ path: '/relays/moq/admission', status: 200 })]);
    // The key travels as auth URL userinfo, which the relay sends as Basic credentials rather than in the URL.
    expect(connects()[0]?.headers.get('authorization')).toMatch(/^Basic /);
    expect(JSON.parse(connects()[0]?.body ?? '{}')).toMatchObject({ transport: 'http', path: `/${ROOM}` });
  });

  it('reports the end of the session it admitted', async () => {
    const { credentials } = await issueGrant();
    await announced(ROOM, credentials.moq?.token);
    await expect
      .poll(() => gatekeeper.callouts.map(callout => JSON.parse(callout.body).event))
      .toEqual(['connect', 'end']);
  });

  it('refuses a session without a token', async () => {
    expect((await announced(ROOM)).status).toBe(401);
    expect(connects()).toEqual([expect.objectContaining({ status: 403 })]);
  });

  it('refuses a token gatekeeper did not sign', async () => {
    const { credentials } = await issueGrant();
    const [header, payload] = (credentials.moq?.token ?? '').split('.');
    expect((await announced(ROOM, `${header}.${payload}.c2lnbmF0dXJl`)).status).toBe(401);
    expect(connects()).toEqual([expect.objectContaining({ status: 403 })]);
  });

  it('refuses a path outside the token root', async () => {
    const { credentials } = await issueGrant();
    expect((await announced('app-b/room', credentials.moq?.token)).status).toBe(401);
  });

  it('refuses a token whose grant has been revoked', async () => {
    const { grant_id, credentials } = await issueGrant();
    expect((await announced(ROOM, credentials.moq?.token)).status).toBe(200);
    await gatekeeper.database.database.update(grants).set({ revokedAt: new Date() }).where(eq(grants.id, grant_id));
    expect((await announced(ROOM, credentials.moq?.token)).status).toBe(401);
  });
});

describe('moq-relay without the relay key', () => {
  it('is refused even for a valid session token', async () => {
    const { credentials } = await issueGrant();
    const response = await fetch(`${impostor.url}/announced/${ROOM}?jwt=${credentials.moq?.token}`);
    expect(response.status).toBe(401);
    expect(connects()).toEqual([expect.objectContaining({ status: 401 })]);
  });
});

describe('static MoQ peers with a shared token', () => {
  it.each([
    ['the correct secret', MOQ_CLUSTER_TOKEN, 200],
    ['an incorrect secret', 'd'.repeat(64), 403]
  ])('checks %s through the real relay callback', async (_label, token, status) => {
    const peers = await startMoqPeers(gatekeeper, token);
    try {
      await expect
        .poll(
          () =>
            connects().filter(callout => {
              const request = JSON.parse(callout.body);
              return request.node === 'peer-b' && callout.status === status;
            }).length,
          { timeout: 30_000 }
        )
        .toBeGreaterThan(0);
      const callout = connects().find(callout => JSON.parse(callout.body).node === 'peer-b')!;
      const request = JSON.parse(callout.body);
      expect(request.path).toBe('/');
      expect(request.tls ?? null).toBeNull();
      expect(new URLSearchParams(request.query).get('jwt')).toBe(token);
      expect(gatekeeper.callouts.every(callout => callout.path === '/relays/moq/admission')).toBe(true);
    } finally {
      await peers.stop();
    }
  });
});
