import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { cameraOrigin } from '../../cameras/drivers.ts';
import { agents, cameras, exposures, gateways, streams } from '../../db/schema.ts';
import { gatewayProvider } from '../../gateways/index.ts';
import { mediamtxPath } from '../../gateways/mediamtx.ts';
import type { AuthenticatedDevice } from '../../middleware/device.ts';
import { useDB } from '../../db/transaction.ts';
import type { Diagnose, ExposureConfiguration, PublishedExposure, ServedExposure, ServedRendition } from './types.ts';

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

/** The exposures an agent delivers: its own MediaMTX gateway's, unless pinned to another device, and those pinned to it. */
export function selectExposures(agentId: string, localGatewayId: string | undefined) {
  const db = useDB({ trusted: true });
  const local =
    localGatewayId === undefined
      ? undefined
      : and(
          eq(exposures.gatewayId, localGatewayId),
          or(isNull(exposures.publisherDeviceId), eq(exposures.publisherDeviceId, agentId))
        );
  return (
    db
      .select({
        id: exposures.id,
        streamId: exposures.streamId,
        gatewayId: exposures.gatewayId,
        gatewayKind: gateways.kind,
        upstreamExposureId: exposures.upstreamExposureId,
        renditions: exposures.renditions,
        cameraSettings: cameras.settings,
        cameraCredentials: cameras.credentials
      })
      .from(exposures)
      .innerJoin(streams, eq(streams.id, exposures.streamId))
      .leftJoin(cameras, eq(cameras.id, streams.sourceDeviceId))
      // A built-in gateway's slug matches no organisation gateway, so it has no kind here.
      .leftJoin(gateways, sql`${gateways.id}::text = ${exposures.gatewayId}`)
      .where(or(local, eq(exposures.publisherDeviceId, agentId)))
      .orderBy(exposures.id)
  );
}
export type ExposureRow = Awaited<ReturnType<typeof selectExposures>>[number];

// Planning, from what was read alone.

/** An exposure the agent's MediaMTX serves: each rendition its stream's camera can produce, and where to pull it. */
export function planServed(row: ExposureRow, diagnose: Diagnose): ServedExposure | undefined {
  if (row.cameraSettings === null) {
    diagnose("Its stream's source is not a camera, so nothing can be pulled");
    return undefined;
  }
  if (row.upstreamExposureId !== null) diagnose('Its upstream is ignored: the camera is pulled directly');
  const credentials = row.cameraCredentials ?? undefined;
  const renditions: ServedRendition[] = [];
  for (const rendition of row.renditions) {
    const source = cameraOrigin(row.cameraSettings, credentials, rendition);
    if (source === undefined) diagnose(`The camera cannot produce ${rendition}, and nothing transcodes yet`);
    else renditions.push({ rendition, path: mediamtxPath(row.id, rendition), source });
  }
  if (renditions.length === 0) return undefined;
  return { ingest: 'pull', streamId: row.streamId, gatewayId: row.gatewayId, renditions };
}

/** An exposure the agent publishes by MoQ, from an upstream its MediaMTX serves: the renditions that upstream does. */
export function planPublished(
  row: ExposureRow,
  planned: Record<string, ExposureConfiguration>,
  diagnose: Diagnose
): PublishedExposure | undefined {
  const provider = gatewayProvider(row.gatewayId, row.gatewayKind ?? '');
  if (!('moq' in provider.ingest)) {
    diagnose(`Agents publish only by moq, which ${provider.name} does not take`);
    return undefined;
  }
  const upstream = row.upstreamExposureId === null ? undefined : planned[row.upstreamExposureId];
  if (row.upstreamExposureId === null || upstream?.ingest !== 'pull') {
    diagnose("It must publish from an upstream exposure this agent's MediaMTX serves");
    return undefined;
  }
  const renditions = row.renditions.flatMap(rendition => {
    const served = upstream.renditions.find(candidate => candidate.rendition === rendition);
    return served === undefined ? [] : [{ rendition, source: served.path }];
  });
  if (renditions.length === 0) return undefined;
  const { streamId, gatewayId, upstreamExposureId } = row;
  return { ingest: 'moq', streamId, gatewayId, upstreamExposureId, renditions };
}
