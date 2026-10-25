import type { AuthenticatedDevice } from '../../middleware/device.ts';
import { trustedTransaction } from '../../db/transaction.ts';
import { ensureGatewayTls } from '../../gateways/certificates.ts';
import { gatewayProvider } from '../../gateways/index.ts';
import { mediamtxPath } from '../../gateways/mediamtx.ts';
import type { Rendition } from '../../topology/settings.ts';
import {
  type Diagnose,
  type ExposureInput,
  type Feed,
  type StreamInput,
  cameraFeeds,
  mediamtxAuth,
  selectGatewayIdentity,
  selectGatewayKinds,
  selectLocalGateway,
  selectPreferredAddress,
  selectStreams
} from './helpers.ts';
import type { ActiveConfiguration, Diagnostic, PlannedConfiguration, PlannedPath, PlannedPublisher } from './types.ts';

export type * from './types.ts';

// A device's configuration: what it should be doing, derived from the topology whenever it asks, never stored. Only
// agents have one so far. The network's active agent runs the MediaMTX gateway on its network, and delivers each
// exposure of a stream that is a hop of it: its gateway's, and those pinned to it on other gateways.
//
// A hop takes its media from its upstream, or with none from the stream's source, which only a camera can be so far.
// What the agent does with it depends on where the hop is delivered:
//
//   serves    an exposure of its own gateway: a path for each rendition, pulled from the camera or the upstream's path;
//   publishes an exposure of another gateway, by MoQ: read from the upstream's path, or one pulling the camera.
//
// The configuration says exactly what the agent runs, MediaMTX paths and MoQ publishers, so the agent decides nothing
// itself. Planning reads the agent's part of the topology, then decides from it alone. What it cannot plan yet
// (transcoding, upstreams another device delivers, publishing by other protocols) is left out, with a diagnostic
// saying why.
//
// After the plan, outside its transaction since it waits on the network, the gateway's hostname and certificate
// (src/gateways/certificates.ts): pointed at the agent's preferred address, and issued or renewed when due.

/** The signing device's configuration, read by trusted code: a device principal cannot read the topology. */
export async function planConfiguration(device: AuthenticatedDevice): Promise<PlannedConfiguration> {
  const planned = await trustedTransaction(async () => {
    if (device.kind !== 'agent') {
      throw new Error('Currently planning configuration is only supported for agents.');
    }

    const gatewayId = await selectLocalGateway(device);
    if (!gatewayId) return undefined;

    const streams = await selectStreams(device.id, gatewayId);
    const gatewayKinds = await selectGatewayKinds(device.organisationId);
    const gateway = await selectGatewayIdentity(gatewayId);
    const address = await selectPreferredAddress(device.id);
    const configuration = planActiveAgent({ organisationId: device.organisationId, gatewayId, gatewayKinds, streams });
    return { configuration, gateway, address };
  });
  if (planned === undefined) return { state: 'idle' };

  const { configuration, gateway, address } = planned;
  const tls = await ensureGatewayTls(gateway, address, message =>
    configuration.diagnostics.push({ subject: `gateway:${gateway.id}`, message })
  );
  if (tls !== undefined) configuration.mediamtx.tls = tls;
  return configuration;
}

/** What planning an active agent decides from: its MediaMTX gateway, and each stream it delivers some of. */
interface PlanningInput {
  organisationId: string;
  gatewayId: string;
  /** The kind of each of the organisation's own gateways, by ID. */
  gatewayKinds: Map<string, string>;
  streams: StreamInput[];
}

function planActiveAgent(input: PlanningInput): ActiveConfiguration {
  const diagnostics: Diagnostic[] = [];
  const paths: PlannedPath[] = [];
  const publishers: PlannedPublisher[] = [];
  const auth = mediamtxAuth(input.gatewayId, message =>
    diagnostics.push({ subject: `gateway:${input.gatewayId}`, message })
  );

  for (const stream of input.streams) {
    const exposures = new Map(stream.exposures.map(exposure => [exposure.id, exposure]));
    // Each exposure planned so far, by ID: the path each of its renditions is read from on this MediaMTX. Hops are
    // planned upstream first, whichever order they come in; the routes refuse a chain that loops.
    const planned = new Map<string, Map<Rendition, string>>();

    /**
     * Plans the hop once: each rendition from its feed, onto a path of the hop's own when it is served or pulled to be
     * published, or straight from its upstream's path when published; then its publisher, when it has renditions.
     */
    const plan = (exposure: ExposureInput): Map<Rendition, string> => {
      const done = planned.get(exposure.id);
      if (done !== undefined) return done;
      const local = new Map<Rendition, string>();
      planned.set(exposure.id, local);
      const diagnose: Diagnose = message => diagnostics.push({ subject: `exposure:${exposure.id}`, message });

      const serves = exposure.gatewayId === input.gatewayId;
      const layout = serves ? undefined : publishLayout(exposure, diagnose);
      if (!serves && layout === undefined) return local;

      for (const [rendition, feed] of feedsOf(exposure, diagnose)) {
        // A publisher reads an upstream's path as it is; anything else is a path of the exposure's own.
        if (!serves && 'path' in feed) {
          local.set(rendition, feed.path);
          continue;
        }
        const name = mediamtxPath(exposure.id, rendition);
        paths.push({ name, exposureId: exposure.id, rendition, source: feed });
        local.set(rendition, name);
      }

      if (layout !== undefined && local.size > 0) {
        publishers.push({
          exposureId: exposure.id,
          connect: {
            id: input.organisationId,
            streamId: stream.id,
            exposureId: exposure.id,
            action: 'publish',
            protocol: 'moq'
          },
          layout,
          renditions: [...local].map(([rendition, path]) => ({ rendition, path }))
        });
      }
      return local;
    };

    /** Where each of the hop's renditions comes from: its upstream if it has one, otherwise the stream's source. */
    const feedsOf = (exposure: ExposureInput, diagnose: Diagnose): Map<Rendition, Feed> => {
      const feeds = new Map<Rendition, Feed>();
      if (exposure.upstreamExposureId !== null) {
        const upstream = exposures.get(exposure.upstreamExposureId);
        // TODO: Read an upstream another device delivers, by `connect` (action: 'read').
        if (upstream === undefined) {
          diagnose('Its upstream is delivered by another device, which this agent cannot read yet');
          return feeds;
        }
        const served = plan(upstream);
        for (const rendition of exposure.renditions) {
          const path = served.get(rendition);
          if (path === undefined) diagnose(`Its upstream does not deliver ${rendition} here`);
          else feeds.set(rendition, { path });
        }
        return feeds;
      }
      const device = stream.sourceDevice;
      if (!device) {
        diagnose('Its stream has no source');
        return feeds;
      }
      if (!device.camera) {
        diagnose(`Its stream's source is a ${device.kind}, which cannot be pulled`);
        return feeds;
      }
      return cameraFeeds(exposure, device.camera, diagnose);
    };

    /** How the hop's gateway takes it by MoQ, the only protocol agents publish by, if it does in a way they can. */
    const publishLayout = (exposure: ExposureInput, diagnose: Diagnose) => {
      const provider = gatewayProvider(exposure.gatewayId, input.gatewayKinds.get(exposure.gatewayId) ?? '');
      const layout = provider.ingest.moq;
      if (layout === undefined) diagnose(`Agents publish only by moq, which ${provider.name} does not take`);
      else if (layout !== 'tracks')
        diagnose(`Agents publish by moq only as tracks of one broadcast, which ${provider.name} does not take`);
      else return layout;
      return undefined;
    };

    for (const exposure of stream.exposures) plan(exposure);
  }

  return { state: 'active', mediamtx: { gatewayId: input.gatewayId, auth }, paths, publishers, diagnostics };
}
