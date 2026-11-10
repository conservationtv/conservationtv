import { programSubject } from '@conservationtv/reports';
import type { AuthenticatedDevice } from '../../middleware/device.ts';
import { trustedTransaction } from '../../db/transaction.ts';
import { ensureGatewayTls } from '../../gateways/certificates.ts';
import { gatewayProvider } from '../../gateways/index.ts';
import { mediamtxPath } from '../../gateways/mediamtx.ts';
import type { Rendition } from '../../topology/settings.ts';
import { useEnvironment } from '../../env/env.ts';
import { selectOutputPlan, selectOutputShow } from '../../services/shows.ts';
import {
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
import type {
  MediamtxConfiguration,
  ObsConfiguration,
  PlannedConfiguration,
  PlannedPath,
  PlannedPublisher
} from './types.ts';

export type * from './types.ts';

// A device's configuration: what it should be doing, derived from the topology whenever it asks, never stored. Only
// agents have one so far, with a section for each runtime it runs, and none for those it doesn't. The network's active
// agent runs the MediaMTX gateway on its network (`mediamtx`), and delivers each exposure of a stream that is a hop of
// it: its gateway's, and those pinned to it on other gateways. A show's output runs OBS (`obs`), following the show;
// what it plays comes with the show, so here are only which show, and where its program goes: the show's encoding, its
// enabled forwards, its previews and its recorder.
//
// A hop takes its media from its upstream, or with none from the stream's source, which only a camera can be so far.
// What the agent does with it depends on where the hop is delivered:
//
//   serves    an exposure of its own gateway: a path for each rendition, pulled from the camera or the upstream's path;
//   publishes an exposure of another gateway, by MoQ: read from the upstream's path, or one pulling the camera.
//
// The configuration says exactly what the agent runs, MediaMTX paths and MoQ publishers, so the agent decides nothing
// itself. Planning reads the agent's part of the topology, then decides from it alone. What it cannot plan yet
// (transcoding, upstreams another device delivers, publishing by other protocols) is left out.
//
// After the plan, outside its transaction since it waits on the network, the gateway's hostname and certificate
// (src/gateways/certificates.ts): pointed at the agent's preferred address, and issued or renewed when due.

/** The signing device's configuration, read by trusted code: a device principal cannot read the topology. */
export async function planConfiguration(device: AuthenticatedDevice): Promise<PlannedConfiguration> {
  if (device.kind !== 'agent') {
    throw new Error('Currently planning configuration is only supported for agents.');
  }
  // One after the other: each is a trusted transaction, on the one admin connection.
  const mediamtx = await planMediamtx(device);
  const obs = await planObs(device);
  return { mediamtx, obs };
}

/** The `mediamtx` runtime, for the network's active agent on a network with a MediaMTX gateway. */
async function planMediamtx(device: AuthenticatedDevice): Promise<MediamtxConfiguration | undefined> {
  const planned = await trustedTransaction(async () => {
    const gatewayId = await selectLocalGateway(device);
    if (!gatewayId) return undefined;

    const streams = await selectStreams(device.id, gatewayId);
    const gatewayKinds = await selectGatewayKinds(device.organisationId);
    const gateway = await selectGatewayIdentity(gatewayId);
    const address = await selectPreferredAddress(device.id);
    const configuration = planActiveAgent({ organisationId: device.organisationId, gatewayId, gatewayKinds, streams });
    return { configuration, gateway, address };
  });
  if (planned === undefined) return undefined;

  const { configuration, gateway, address } = planned;
  const tls = await ensureGatewayTls(gateway, address);
  if (tls !== undefined) configuration.tls = tls;
  return configuration;
}

/** The `obs` runtime, for a show's output: the show, where its stream is followed, and where its program goes. */
async function planObs(device: AuthenticatedDevice): Promise<ObsConfiguration | undefined> {
  const planned = await trustedTransaction(async () => {
    const output = await selectOutputShow(device.id);
    if (output === undefined) return undefined;
    const show = await selectOutputPlan(output.showId);
    const gatewayKinds = await selectGatewayKinds(output.organisationId);
    return { output, show: show!, gatewayKinds };
  });
  if (planned === undefined) return undefined;
  const { output, show, gatewayKinds } = planned;
  const { organisationId, showId } = output;
  const environment = useEnvironment();
  // Every show follows its organisation's one broadcast for now, at the organisation's (src/routes/broadcast.ts).
  const url = new URL(`/organisations/${organisationId}/show`, environment.variables.APP_URL);
  const { forwards, previews, recorders, ...encoding } = show;
  const [recorder] = recorders;
  return {
    show: { id: showId, url: url.href },
    output: encoding,
    forwards: forwards.map(forward => ({ organisationId, channelId: forward.channelId, forwardId: forward.id })),
    previews: previews.map(preview => ({
      previewId: preview.id,
      gatewayId: preview.gatewayId,
      connect: {
        id: organisationId,
        showId,
        previewId: preview.id,
        action: 'publish',
        protocol: previewProtocol(preview.gatewayId, gatewayKinds)
      }
    })),
    ...(recorder && { recording: { recorderId: recorder.id, kind: recorder.kind, params: recorder.params } }),
    program: { subjectId: programSubject(showId) }
  };
}

/** How an output publishes a preview: by MoQ to a gateway that takes it as tracks of one broadcast, otherwise RTMP. */
function previewProtocol(gatewayId: string, gatewayKinds: Map<string, string>) {
  const provider = gatewayProvider(gatewayId, gatewayKinds.get(gatewayId) ?? '');
  return provider.ingest.moq === 'tracks' ? 'moq' : 'rtmp';
}

/** What planning an active agent decides from: its MediaMTX gateway, and each stream it delivers some of. */
interface PlanningInput {
  organisationId: string;
  gatewayId: string;
  /** The kind of each of the organisation's own gateways, by ID. */
  gatewayKinds: Map<string, string>;
  streams: StreamInput[];
}

function planActiveAgent(input: PlanningInput): MediamtxConfiguration {
  const paths: PlannedPath[] = [];
  const publishers: PlannedPublisher[] = [];
  const auth = mediamtxAuth(input.gatewayId);

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
      const serves = exposure.gatewayId === input.gatewayId;
      const layout = serves ? undefined : publishLayout(exposure);
      if (!serves && layout === undefined) return local;

      for (const [rendition, feed] of feedsOf(exposure)) {
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
    const feedsOf = (exposure: ExposureInput): Map<Rendition, Feed> => {
      const feeds = new Map<Rendition, Feed>();
      if (exposure.upstreamExposureId !== null) {
        const upstream = exposures.get(exposure.upstreamExposureId);
        // TODO: Read an upstream another device delivers, by `connect` (action: 'read').
        if (upstream === undefined) return feeds;
        const served = plan(upstream);
        for (const rendition of exposure.renditions) {
          const path = served.get(rendition);
          if (path !== undefined) feeds.set(rendition, { path });
        }
        return feeds;
      }
      // Only a camera can be pulled from, and only while it is enabled.
      const camera = stream.sourceDevice?.camera;
      if (!camera || camera.state !== 'enabled') return feeds;
      return cameraFeeds(exposure, camera);
    };

    /** How the hop's gateway takes it by MoQ, the only protocol agents publish by, if it does in a way they can. */
    const publishLayout = (exposure: ExposureInput) => {
      const provider = gatewayProvider(exposure.gatewayId, input.gatewayKinds.get(exposure.gatewayId) ?? '');
      // Agents publish by MoQ only as tracks of one broadcast.
      const layout = provider.ingest.moq;
      return layout === 'tracks' ? layout : undefined;
    };

    for (const exposure of stream.exposures) plan(exposure);
  }

  const stats = statsGateways(input, publishers).map(gatewayId => ({ id: input.organisationId, gatewayId }));
  return { gatewayId: input.gatewayId, auth, paths, publishers, stats };
}

/** The gateways the agent publishes to whose relays publish the traffic stats of what they carry, each once. */
function statsGateways(input: PlanningInput, publishers: PlannedPublisher[]): string[] {
  const published = new Set(publishers.map(publisher => publisher.exposureId));
  const gateways = input.streams
    .flatMap(stream => stream.exposures)
    .filter(exposure => published.has(exposure.id))
    .map(exposure => exposure.gatewayId)
    .filter(gatewayId => gatewayProvider(gatewayId, input.gatewayKinds.get(gatewayId) ?? '').stats !== undefined);
  return [...new Set(gateways)];
}
