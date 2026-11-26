import { and, eq, inArray, ne } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import {
  agents,
  cameras,
  deviceAddresses,
  devices,
  exposures,
  gateways,
  organisations,
  outputPreviews
} from '../../db/schema.ts';
import { useDB } from '../../db/transaction.ts';
import { useEnvironment } from '../../env/env.ts';
import { BUILTIN_GATEWAY_IDS, BUILTIN_GATEWAYS } from '../../gateways/index.ts';
import type { AuthenticatedDevice } from '../../middleware/device.ts';
import type { CameraPathSource, MediamtxAuth, PlannedCamera, PlannedPeer, PushSource } from './types.ts';

// The steps of planning a device's configuration (src/configuration/plan/index.ts).

// Reading the topology.

/** The MediaMTX gateway on the agent's network, which the agent runs while it is the network's active agent. */
export async function selectLocalGateway(device: AuthenticatedDevice) {
  const db = useDB({ trusted: true });
  const [agent] = await db
    .select({ networkId: agents.networkId, active: agents.active })
    .from(agents)
    .where(eq(agents.id, device.id));
  if (!agent?.active) return undefined;
  const [gateway] = await db
    .select({ id: gateways.id })
    .from(gateways)
    .where(
      and(
        eq(gateways.organisationId, device.organisationId),
        eq(gateways.networkId, agent.networkId),
        eq(gateways.kind, 'mediamtx')
      )
    )
    .orderBy(gateways.id)
    .limit(1);
  return gateway?.id;
}

/** The network the agent is the active agent of, if it is one: whose cameras it controls. */
export async function selectActiveNetwork(device: AuthenticatedDevice) {
  const db = useDB({ trusted: true });
  const [agent] = await db
    .select({ networkId: agents.networkId, active: agents.active })
    .from(agents)
    .where(eq(agents.id, device.id));
  return agent?.active ? agent.networkId : undefined;
}

/** The cameras on a network, as they are registered, with their credentials: for the agent that reaches them. */
export async function selectNetworkCameras(organisationId: string, networkId: string): Promise<PlannedCamera[]> {
  const db = useDB({ trusted: true });
  const rows = await db
    .select({
      id: cameras.id,
      settings: cameras.settings,
      credentials: cameras.credentials,
      state: cameras.state
    })
    .from(cameras)
    .innerJoin(devices, eq(devices.id, cameras.id))
    .where(and(eq(cameras.organisationId, organisationId), eq(devices.networkId, networkId)))
    .orderBy(cameras.id);
  return rows.map(({ credentials, ...camera }) => ({ ...camera, ...(credentials !== null && { credentials }) }));
}

/**
 * The devices the agent serves over iroh: every other agent of its organisation, which may holepunch to it, and every
 * browser, which is served through the relay alone, so it never learns the agent's addresses. Cameras dial no one.
 */
export async function selectPeers(device: AuthenticatedDevice): Promise<PlannedPeer[]> {
  const db = useDB({ trusted: true });
  const rows = await db
    .select({ endpointId: devices.publicId, kind: devices.kind })
    .from(devices)
    .where(
      and(
        eq(devices.organisationId, device.organisationId),
        inArray(devices.kind, ['agent', 'browser']),
        ne(devices.id, device.id)
      )
    )
    .orderBy(devices.id);
  return rows.map(({ endpointId, kind }) => ({ endpointId, allow: { relayed: true, direct: kind === 'agent' } }));
}

/**
 * Who signs tokens for each of the organisation's gateways that an agent runs: the key ID (public ID) of the active agent
 * on its network, as src/gateways/mediamtx.ts signs with, by gateway ID. A built-in gateway, or one no agent is active
 * for, is absent.
 */
export async function selectGatewaySigners(organisationId: string) {
  const db = useDB({ trusted: true });
  const rows = await db
    .select({ gatewayId: gateways.id, signer: devices.publicId })
    .from(gateways)
    .innerJoin(
      agents,
      and(eq(agents.organisationId, gateways.organisationId), eq(agents.networkId, gateways.networkId))
    )
    .innerJoin(devices, eq(devices.id, agents.id))
    .where(and(eq(gateways.organisationId, organisationId), eq(agents.active, true)));
  return new Map(rows.map(row => [row.gatewayId, row.signer]));
}

/** The gateway and the names its hostname is made from (src/gateways/certificates.ts). */
export async function selectGatewayIdentity(gatewayId: string) {
  const db = useDB({ trusted: true });
  const [row] = await db
    .select({
      id: gateways.id,
      organisationId: gateways.organisationId,
      name: gateways.name,
      organisationName: organisations.name
    })
    .from(gateways)
    .innerJoin(organisations, eq(organisations.id, gateways.organisationId))
    .where(eq(gateways.id, gatewayId));
  return row!;
}

/** The address the agent last reported its default route leaves by, where its gateway's hostname should point. */
export async function selectPreferredAddress(deviceId: string) {
  const db = useDB({ trusted: true });
  const [row] = await db
    .select({ address: deviceAddresses.address })
    .from(deviceAddresses)
    .where(and(eq(deviceAddresses.deviceId, deviceId), eq(deviceAddresses.preferred, true)));
  return row?.address;
}

/**
 * Which exposures an agent delivers: its own MediaMTX gateway's, unless pinned to another device; those pinned to it;
 * and those pinned to none whose upstream is its gateway's, such as a MoQ copy of a camera's exposure there, so the copy
 * follows the network's active agent as its upstream does. An unpinned exposure with no upstream on another gateway
 * has no agent to deliver it.
 */
function delivered(agentId: string, gatewayId: string) {
  return {
    OR: [
      { gatewayId, OR: [{ publisherDeviceId: { isNull: true as const } }, { publisherDeviceId: agentId }] },
      { publisherDeviceId: agentId },
      { publisherDeviceId: { isNull: true as const }, upstream: { gatewayId } }
    ]
  };
}

/**
 * Each stream the agent delivers some of: where each of its chains starts, its source device and the camera that is,
 * and the exposures of it the agent delivers, each a hop fed by its upstream or, with none, by the source.
 */
export function selectStreams(agentId: string, gatewayId: string) {
  const db = useDB({ trusted: true });
  return db.query.streams.findMany({
    columns: { id: true, sourceDeviceId: true },
    with: {
      sourceDevice: {
        columns: { kind: true },
        with: { camera: { columns: { settings: true, credentials: true, state: true } } }
      },
      exposures: {
        columns: { id: true, gatewayId: true, upstreamExposureId: true },
        where: delivered(agentId, gatewayId),
        orderBy: { id: 'asc' }
      }
    },
    where: { exposures: delivered(agentId, gatewayId) },
    orderBy: { id: 'asc' }
  });
}
export type StreamInput = Awaited<ReturnType<typeof selectStreams>>[number];
export type ExposureInput = StreamInput['exposures'][number];

/** One of the organisation's exposures on a gateway whose relays publish stats, and the agent that covers it. */
export interface CoveredExposure {
  id: string;
  streamId: string;
  gatewayId: string;
  /** The agent that reports what the relays carry of it, and whether they have it; null while the organisation has none. */
  coveredBy: string | null;
}

/**
 * Who covers each of the organisation's exposures on a gateway whose relays publish stats (docs/shows.md, Health and
 * stats without an agent): exactly one agent, which reports what the relays carry of it and whether they have it.
 *
 *   the agent that delivers it   as `delivered` decides: its pinned publisher, or with none the active agent whose
 *                                MediaMTX gateway its upstream is on, while that agent runs a gateway, so has the
 *                                exposure in its plan, whether or not it can publish it now;
 *   otherwise the fallback       the organisation's oldest active agent (the lowest ID: they are UUIDv7). A browser
 *                                publishing straight to the relay, an exposure whose upstream no agent delivers, or one
 *                                pinned to a device that is not an agent running a gateway, is covered by it.
 *
 * The fallback is chosen from rows alone, never from who is online, so every agent that asks works it out the same, and
 * it changes only when that agent is removed or stops being its network's active agent. Two agents can both believe
 * they cover an exposure for at most one configuration interval each: both read the same relay, so their opinions
 * agree, and the one no longer told to stops reporting and goes stale.
 */
export async function selectRelayCoverage(organisationId: string): Promise<CoveredExposure[]> {
  const statsGatewayIds = BUILTIN_GATEWAY_IDS.filter(id => BUILTIN_GATEWAYS[id].stats !== undefined);
  if (statsGatewayIds.length === 0) return [];
  const db = useDB({ trusted: true });
  const upstreams = alias(exposures, 'upstream');
  const rows = await db
    .select({
      id: exposures.id,
      streamId: exposures.streamId,
      gatewayId: exposures.gatewayId,
      publisherDeviceId: exposures.publisherDeviceId,
      upstreamGatewayId: upstreams.gatewayId
    })
    .from(exposures)
    .leftJoin(upstreams, eq(upstreams.id, exposures.upstreamExposureId))
    .where(and(eq(exposures.organisationId, organisationId), inArray(exposures.gatewayId, statsGatewayIds)))
    .orderBy(exposures.id);
  if (rows.length === 0) return [];
  // Each active agent, oldest first, with the MediaMTX gateway it runs, as `selectLocalGateway` picks it: the first.
  const active = await db
    .select({ id: agents.id, gatewayId: gateways.id })
    .from(agents)
    .leftJoin(
      gateways,
      and(
        eq(gateways.organisationId, agents.organisationId),
        eq(gateways.networkId, agents.networkId),
        eq(gateways.kind, 'mediamtx')
      )
    )
    .where(and(eq(agents.organisationId, organisationId), eq(agents.active, true)))
    .orderBy(agents.id, gateways.id);
  const runs = new Map<string, string>();
  for (const { id, gatewayId } of active) if (gatewayId !== null && !runs.has(id)) runs.set(id, gatewayId);
  const agentOf = new Map([...runs].map(([agentId, gatewayId]) => [gatewayId, agentId]));
  const fallback = active[0]?.id ?? null;
  return rows.map(({ publisherDeviceId, upstreamGatewayId, ...exposure }) => {
    // Its pinned publisher, while that agent runs a gateway; with none pinned, the agent whose gateway its upstream is
    // on; otherwise, or with neither delivering it, the fallback.
    const pinned = publisherDeviceId !== null && runs.has(publisherDeviceId) ? publisherDeviceId : undefined;
    const upstream =
      publisherDeviceId === null && upstreamGatewayId !== null ? agentOf.get(upstreamGatewayId) : undefined;
    return { ...exposure, coveredBy: pinned ?? upstream ?? fallback };
  });
}

/** The kind of each of the organisation's own gateways, by ID: a built-in gateway's slug says what it is. */
export async function selectGatewayKinds(organisationId: string) {
  const db = useDB({ trusted: true });
  const rows = await db
    .select({ id: gateways.id, kind: gateways.kind })
    .from(gateways)
    .where(eq(gateways.organisationId, organisationId));
  return new Map(rows.map(row => [row.id, row.kind]));
}

/** The outputs' previews delivered to the gateway: each is published to a path of its own there, by the output's agent. */
export function selectGatewayPreviews(organisationId: string, gatewayId: string) {
  const db = useDB({ trusted: true });
  return db
    .select({ id: outputPreviews.id })
    .from(outputPreviews)
    .where(and(eq(outputPreviews.organisationId, organisationId), eq(outputPreviews.gatewayId, gatewayId)));
}

// Planning, from what was read alone.

/**
 * Where an exposure comes from on this agent: a camera to pull, a path its MediaMTX already serves, or, for a pushed
 * stream's ingest, its publisher.
 */
export type Feed = CameraPathSource | PushSource;

/**
 * How tokens are checked by the agent's MediaMTX: as src/gateways/mediamtx.ts signs them, with the agent's own key,
 * for its gateway.
 */
export function mediamtxAuth(gatewayId: string): MediamtxAuth {
  const environment = useEnvironment();
  return { issuer: environment.variables.APP_URL, audience: gatewayId };
}
