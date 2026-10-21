import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { cameraOrigin } from '../cameras/drivers.ts';
import { agents, cameras, exposures, gateways, streams } from '../db/schema.ts';
import { useEnvironment } from '../env/env.ts';
import { gatewayProvider } from '../gateways/index.ts';
import { mediamtxPath } from '../gateways/mediamtx.ts';
import type { AuthenticatedDevice } from '../middleware/device.ts';
import { trusted, type Transaction } from '../organisations/membership.ts';
import type { Rendition } from '../topology/settings.ts';

// A device's configuration: what it should be doing, derived from the topology whenever it asks, never stored. Only
// agents have one so far. The network's active agent runs the MediaMTX gateway on its network, so it:
//
//   serves  each exposure of that gateway, pulling every rendition from the stream's camera as the camera's driver
//           says; and
//   publishes each exposure pinned to it on another gateway, by MoQ, from an exposure it serves.
//
// Planning reads the agent's part of the topology, then decides from it alone. What it cannot plan yet (transcoding,
// upstream chains, publishing by other protocols) is left out, with a diagnostic saying why.

/** How a MediaMTX checks a token: against this API's published keys, issued by this API, for its gateway. */
export interface MediamtxAuth {
  jwks: string;
  issuer: string;
  audience: string;
}

/** How the device's MediaMTX admits readers and publishers: tokens this API signs, for its gateway. */
export interface MediamtxConfiguration {
  gatewayId: string;
  auth: MediamtxAuth;
}

/** Where to pull one rendition of a stream from, credentials included. */
export interface RenditionOrigin {
  url: string;
}

export interface StreamConfiguration {
  name: string;
  renditions: Partial<Record<Rendition, RenditionOrigin>>;
}

/** An exposure, by where its connections are made: `organisations/{organisationId}/streams/{streamId}/exposures/{id}`. */
export interface ExposureReference {
  id: string;
  streamId: string;
}

/**
 * An exposure the device delivers. `pull`: the device's own MediaMTX serves each rendition at its path, pulled from
 * the stream's origin. `moq`: the device publishes it to its gateway, reading each rendition from `upstream`, an
 * exposure its own MediaMTX serves, and connects (`organisations.streams.exposures.connect`) to both for credentials.
 */
export interface ExposureConfiguration {
  streamId: string;
  gatewayId: string;
  ingest: string;
  renditions: Rendition[];
  /** For `pull`: the MediaMTX path each rendition is served at. */
  paths: Partial<Record<Rendition, string>>;
  /** For `moq`: the exposure it publishes from. */
  upstream: ExposureReference | null;
}

/** Something the topology asks for that the device's configuration leaves out, and why. */
export interface Diagnostic {
  /** What it is about, as reports name subjects: `exposure:<id>`, `stream:<id>` or `gateway:<id>`. */
  subject: string;
  message: string;
}

export interface PlannedConfiguration {
  /** The device's organisation, which its connections are made under. */
  organisationId: string;
  mediamtx: MediamtxConfiguration | null;
  streams: Record<string, StreamConfiguration>;
  exposures: Record<string, ExposureConfiguration>;
  diagnostics: Diagnostic[];
}

/** The signing device's configuration, read by trusted code: a device principal cannot read the topology. */
export function planConfiguration(device: AuthenticatedDevice): Promise<PlannedConfiguration> {
  return trusted(async tx => {
    if (device.kind !== 'agent') return planAgent(device.organisationId, undefined, []);
    const gatewayId = await selectLocalGateway(tx, device);
    const rows = await selectExposures(tx, device.id, gatewayId);
    return planAgent(device.organisationId, gatewayId, rows);
  });
}

// Reading the topology.

/** The MediaMTX gateway on the agent's network, which the agent runs while it is the network's active agent. */
async function selectLocalGateway(tx: Transaction, device: AuthenticatedDevice) {
  const [agent] = await tx
    .select({ networkId: agents.networkId, active: agents.active })
    .from(agents)
    .where(eq(agents.id, device.id));
  if (!agent?.active) return undefined;
  const [gateway] = await tx
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
function selectExposures(tx: Transaction, agentId: string, localGatewayId: string | undefined) {
  const local =
    localGatewayId === undefined
      ? undefined
      : and(
          eq(exposures.gatewayId, localGatewayId),
          or(isNull(exposures.publisherDeviceId), eq(exposures.publisherDeviceId, agentId))
        );
  return (
    tx
      .select({
        id: exposures.id,
        streamId: exposures.streamId,
        gatewayId: exposures.gatewayId,
        gatewayKind: gateways.kind,
        upstreamExposureId: exposures.upstreamExposureId,
        renditions: exposures.renditions,
        streamName: streams.name,
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
type ExposureRow = Awaited<ReturnType<typeof selectExposures>>[number];

// Planning, from what was read alone.

/** Records why the exposure is left out of the configuration, or only partly in it. */
type Diagnose = (exposure: ExposureRow, message: string) => void;

/** The agent's configuration: its MediaMTX, if it runs one, the exposures that serves, then those it publishes. */
function planAgent(organisationId: string, gatewayId: string | undefined, rows: ExposureRow[]): PlannedConfiguration {
  const diagnostics: Diagnostic[] = [];
  const diagnose: Diagnose = (exposure, message) => diagnostics.push({ subject: `exposure:${exposure.id}`, message });
  const mediamtx = gatewayId === undefined ? null : planMediamtx(gatewayId, diagnostics);
  const planned: PlannedConfiguration = { organisationId, mediamtx, streams: {}, exposures: {}, diagnostics };
  // Served first, so the exposures published from them find them planned.
  for (const row of rows.filter(row => row.gatewayId === gatewayId)) {
    const served = planServed(row, diagnose);
    if (served === undefined) continue;
    planned.exposures[row.id] = served.exposure;
    const stream = planned.streams[row.streamId] ?? { name: row.streamName, renditions: {} };
    stream.renditions = { ...stream.renditions, ...served.origins };
    planned.streams[row.streamId] = stream;
  }
  for (const row of rows.filter(row => row.gatewayId !== gatewayId)) {
    const published = planPublished(row, planned.exposures, diagnose);
    if (published !== undefined) planned.exposures[row.id] = published;
  }
  return planned;
}

/** How the agent's MediaMTX checks the tokens this API signs for its gateway (src/gateways/mediamtx.ts). */
function planMediamtx(gatewayId: string, diagnostics: Diagnostic[]): MediamtxConfiguration {
  const environment = useEnvironment();
  if (environment.gatewayKeys === undefined) {
    const message = 'GATEWAY_SIGNING_KEYS is unset, so no reader or publisher can be admitted';
    diagnostics.push({ subject: `gateway:${gatewayId}`, message });
  }
  const issuer = environment.variables.APP_URL;
  return { gatewayId, auth: { jwks: new URL('/gateway-keys', issuer).href, issuer, audience: gatewayId } };
}

/** An exposure the agent's MediaMTX serves: each rendition its stream's camera can produce, and where to pull it. */
function planServed(row: ExposureRow, diagnose: Diagnose) {
  if (row.cameraSettings === null) {
    diagnose(row, "Its stream's source is not a camera, so nothing can be pulled");
    return undefined;
  }
  if (row.upstreamExposureId !== null) diagnose(row, 'Its upstream is ignored: the camera is pulled directly');
  const credentials = row.cameraCredentials ?? undefined;
  const origins: Partial<Record<Rendition, RenditionOrigin>> = {};
  const paths: Partial<Record<Rendition, string>> = {};
  for (const rendition of row.renditions) {
    const url = cameraOrigin(row.cameraSettings, credentials, rendition);
    if (url === undefined) {
      diagnose(row, `The camera cannot produce ${rendition}, and nothing transcodes yet`);
      continue;
    }
    origins[rendition] = { url };
    paths[rendition] = mediamtxPath(row.id, rendition);
  }
  const renditions = row.renditions.filter(rendition => origins[rendition] !== undefined);
  if (renditions.length === 0) return undefined;
  const { streamId, gatewayId } = row;
  const exposure: ExposureConfiguration = { streamId, gatewayId, ingest: 'pull', renditions, paths, upstream: null };
  return { exposure, origins };
}

/** An exposure the agent publishes by MoQ, from an upstream its MediaMTX serves: the renditions that upstream does. */
function planPublished(row: ExposureRow, served: Record<string, ExposureConfiguration>, diagnose: Diagnose) {
  const provider = gatewayProvider(row.gatewayId, row.gatewayKind ?? '');
  if (!('moq' in provider.ingest)) {
    diagnose(row, `Agents publish only by moq, which ${provider.name} does not take`);
    return undefined;
  }
  const upstream = row.upstreamExposureId === null ? undefined : served[row.upstreamExposureId];
  if (row.upstreamExposureId === null || upstream?.ingest !== 'pull') {
    diagnose(row, "It must publish from an upstream exposure this agent's MediaMTX serves");
    return undefined;
  }
  const renditions = row.renditions.filter(rendition => upstream.renditions.includes(rendition));
  if (renditions.length === 0) return undefined;
  const { streamId, gatewayId } = row;
  const reference = { id: row.upstreamExposureId, streamId: upstream.streamId };
  const exposure: ExposureConfiguration = {
    streamId,
    gatewayId,
    ingest: 'moq',
    renditions,
    paths: {},
    upstream: reference
  };
  return exposure;
}
