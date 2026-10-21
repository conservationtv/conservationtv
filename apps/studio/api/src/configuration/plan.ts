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
// Each exposure says exactly what the agent runs for it, so the agent decides nothing itself. Planning reads the
// agent's part of the topology, then decides from it alone. What it cannot plan yet (transcoding, upstream chains,
// publishing by other protocols) is left out, with a diagnostic saying why.

/** A rendition the agent's MediaMTX serves: at `path`, pulled from `source` while it is read. */
export interface ServedRendition {
  rendition: Rendition;
  path: string;
  /** Where to pull it from, such as the camera's RTSP URL, credentials included. */
  source: string;
}

/** A rendition the agent publishes: read from `source`, a path its own MediaMTX serves. */
export interface PublishedRendition {
  rendition: Rendition;
  source: string;
}

/** An exposure the agent's MediaMTX serves, each rendition pulled from the stream's origin. */
export interface ServedExposure {
  ingest: 'pull';
  streamId: string;
  gatewayId: string;
  renditions: ServedRendition[];
}

/**
 * An exposure the agent publishes to its gateway by MoQ, reading each rendition from what its MediaMTX serves of
 * `upstreamExposureId`, and connecting (`organisations.streams.exposures.connect`) for credentials.
 */
export interface PublishedExposure {
  ingest: 'moq';
  streamId: string;
  gatewayId: string;
  upstreamExposureId: string;
  renditions: PublishedRendition[];
}

export type ExposureConfiguration = ServedExposure | PublishedExposure;

/** Something the topology asks for that the device's configuration leaves out, and why. */
export interface Diagnostic {
  /** What it is about, as reports name subjects: `exposure:<id>` or `gateway:<id>`. */
  subject: string;
  message: string;
}

/** How a MediaMTX checks a token: against this API's published keys, issued by this API, for its gateway. */
export interface MediamtxAuth {
  jwks: string;
  issuer: string;
  audience: string;
}

/** The MediaMTX gateway the device runs, and how it admits readers and publishers: by tokens this API signs for it. */
export interface MediamtxConfiguration {
  gatewayId: string;
  auth: MediamtxAuth;
}

export interface PlannedConfiguration {
  /** The device's organisation, which its connections are made under. */
  organisationId: string;
  mediamtx: MediamtxConfiguration | null;
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

/** The agent's configuration: its MediaMTX, if it runs one, the exposures that serves, then those it publishes. */
function planAgent(organisationId: string, gatewayId: string | undefined, rows: ExposureRow[]): PlannedConfiguration {
  const planned: PlannedConfiguration = { organisationId, mediamtx: null, exposures: {}, diagnostics: [] };
  const diagnose = (subject: string, message: string) => planned.diagnostics.push({ subject, message });
  if (gatewayId !== undefined) {
    const environment = useEnvironment();
    if (environment.gatewayKeys === undefined)
      diagnose(`gateway:${gatewayId}`, 'GATEWAY_SIGNING_KEYS is unset, so no reader or publisher can be admitted');
    // How src/gateways/mediamtx.ts signs its tokens.
    const issuer = environment.variables.APP_URL;
    const auth = { jwks: new URL('/gateway-keys', issuer).href, issuer, audience: gatewayId };
    planned.mediamtx = { gatewayId, auth };
  }
  // Served first, so the exposures published from them find them planned.
  for (const row of rows.filter(row => row.gatewayId === gatewayId)) {
    const served = planServed(row, message => diagnose(`exposure:${row.id}`, message));
    if (served !== undefined) planned.exposures[row.id] = served;
  }
  for (const row of rows.filter(row => row.gatewayId !== gatewayId)) {
    const published = planPublished(row, planned.exposures, message => diagnose(`exposure:${row.id}`, message));
    if (published !== undefined) planned.exposures[row.id] = published;
  }
  return planned;
}

/** Records why the exposure is left out of the configuration, or only partly in it. */
type Diagnose = (message: string) => void;

/** An exposure the agent's MediaMTX serves: each rendition its stream's camera can produce, and where to pull it. */
function planServed(row: ExposureRow, diagnose: Diagnose): ServedExposure | undefined {
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
function planPublished(
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
