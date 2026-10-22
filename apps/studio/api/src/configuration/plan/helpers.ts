import { and, eq } from 'drizzle-orm';
import { cameraOrigin } from '../../cameras/drivers.ts';
import { agents, gateways } from '../../db/schema.ts';
import { useDB } from '../../db/transaction.ts';
import { useEnvironment } from '../../env/env.ts';
import type { AuthenticatedDevice } from '../../middleware/device.ts';
import type { Rendition } from '../../topology/settings.ts';
import type { MediamtxAuth, PathSource } from './types.ts';

// The steps of planning a device's configuration (src/configuration/plan/index.ts).

/** Records why something is left out of the configuration, or only partly in it. */
export type Diagnose = (message: string) => void;

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

/** Which exposures an agent delivers: its own MediaMTX gateway's, unless pinned to another device, and those pinned to it. */
function delivered(agentId: string, gatewayId: string) {
  return {
    OR: [
      { gatewayId, OR: [{ publisherDeviceId: { isNull: true as const } }, { publisherDeviceId: agentId }] },
      { publisherDeviceId: agentId }
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
    columns: { id: true },
    with: {
      sourceDevice: {
        columns: { kind: true },
        with: { camera: { columns: { settings: true, credentials: true } } }
      },
      exposures: {
        columns: { id: true, gatewayId: true, upstreamExposureId: true, renditions: true },
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
/** A stream's source device's camera, when it is one. */
export type CameraInput = NonNullable<NonNullable<StreamInput['sourceDevice']>['camera']>;

/** The kind of each of the organisation's own gateways, by ID: a built-in gateway's slug says what it is. */
export async function selectGatewayKinds(organisationId: string) {
  const db = useDB({ trusted: true });
  const rows = await db
    .select({ id: gateways.id, kind: gateways.kind })
    .from(gateways)
    .where(eq(gateways.organisationId, organisationId));
  return new Map(rows.map(row => [row.id, row.kind]));
}

// Planning, from what was read alone.

/** Where one rendition of an exposure comes from on this agent: a URL to pull, or a path its MediaMTX already serves. */
export type Feed = PathSource;

/** A camera's renditions, each pulled from where its driver says; the ones it cannot produce are diagnosed. */
export function cameraFeeds(exposure: ExposureInput, camera: CameraInput, diagnose: Diagnose) {
  const feeds = new Map<Rendition, Feed>();
  for (const rendition of exposure.renditions) {
    const url = cameraOrigin(camera.settings, camera.credentials ?? undefined, rendition);
    if (url === undefined) diagnose(`The camera cannot produce ${rendition}, and nothing transcodes yet`);
    else feeds.set(rendition, { url });
  }
  return feeds;
}

/** How tokens are checked by the agent's MediaMTX: as src/gateways/mediamtx.ts signs them, for its gateway. */
export function mediamtxAuth(gatewayId: string, diagnose: Diagnose): MediamtxAuth {
  const environment = useEnvironment();
  if (environment.gatewayKeys === undefined)
    diagnose('GATEWAY_SIGNING_KEYS is unset, so no reader or publisher can be admitted');
  const issuer = environment.variables.APP_URL;
  return { jwks: new URL('/gateway-keys', issuer).href, issuer, audience: gatewayId };
}
