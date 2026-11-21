import { deviceSubject, programSubject } from '@conservationtv/reports';
import { cameraOrigin } from '@conservationtv/cameras';
import type { AuthenticatedDevice } from '../../middleware/device.ts';
import { trustedTransaction } from '../../db/transaction.ts';
import { ensureGatewayTls } from '../../gateways/certificates.ts';
import { gatewayProvider } from '../../gateways/index.ts';
import { mediamtxPath } from '../../gateways/mediamtx.ts';
import type { Rendition } from '../../topology/settings.ts';
import { useEnvironment } from '../../env/env.ts';
import { selectListenedCommands } from '../../services/chat-commands.ts';
import { selectDeviceOutput, selectOutputPlan } from '../../services/outputs.ts';
import {
  type ExposureInput,
  type Feed,
  type StreamInput,
  cameraFeeds,
  mediamtxAuth,
  selectActiveNetwork,
  selectGatewayIdentity,
  selectGatewayKinds,
  selectGatewayPreviews,
  selectLocalGateway,
  selectNetworkCameras,
  selectPeers,
  selectPreferredAddress,
  selectStreams
} from './helpers.ts';
import type {
  CameraMediamtxConfiguration,
  CameraPlannedPath,
  CameraProbe,
  CamerasConfiguration,
  ChatConfiguration,
  ControllingConfiguration,
  ObsConfiguration,
  PlannedCamera,
  PlannedPath,
  PlannedProbe,
  PlannedPublisher,
  ProbingConfiguration,
  ShowConfiguration
} from './types.ts';

export type * from './types.ts';

// A device's configuration: what it should be doing, derived from the topology whenever it asks, never stored. Only
// agents have one so far, with a section for each runtime it runs, and none for those it doesn't. The network's active
// agent runs the MediaMTX gateway on its network (`mediamtx`), and delivers each exposure of a stream that is a hop of
// it: its gateway's, and those pinned to it on other gateways; and takes each output's preview delivered to its gateway,
// on a path an output's agent publishes to. An output's agent runs OBS (`obs`): the output's encoding, its enabled
// forwards, its previews and its recorder, and who drives its scenes; and, while the output follows a show under `show`
// control, the show (`show`), which drives them. What the show plays comes with the show. While that output goes out
// to a Twitch channel and the organisation has chat commands, the agent listens to the channel's chat for them (`chat`).
//
// The active agent also controls the cameras on its network (`cameras`), for whoever presents a grant this API signed
// (src/cameras/grants.ts), and every agent serves the organisation's other agents and browsers over iroh (`peers`).
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
export async function planConfiguration(device: AuthenticatedDevice): Promise<ControllingConfiguration> {
  if (device.kind !== 'agent') {
    throw new Error('Currently planning configuration is only supported for agents.');
  }
  // One after the other: each is a trusted transaction, on the one admin connection.
  const gateway = await planMediamtx(device);
  const { obs, show, chat } = await planOutput(device);
  const { cameras, peers } = await planReach(device, gateway?.cameras ?? []);
  return { mediamtx: gateway?.configuration, cameras, obs, show, chat, peers };
}

/**
 * The configuration as versions before 3 return it: each camera a path is pulled from, or probed at, as the URL its
 * driver gives, credentials included, which those agents pull as it is; and without what they don't read.
 */
export function withCameraUrls(configuration: ControllingConfiguration): ProbingConfiguration {
  const { mediamtx, obs, show } = configuration;
  if (mediamtx === undefined) return { obs, show };
  const cameras = new Map((configuration.cameras?.cameras ?? []).map(camera => [camera.id, camera]));
  const origin = (cameraId: string, rendition: Rendition) => {
    const camera = cameras.get(cameraId)!;
    return cameraOrigin(camera.settings, camera.credentials, rendition)!;
  };
  const paths: PlannedPath[] = mediamtx.paths.map(({ source, ...path }) => ({
    ...path,
    source: 'cameraId' in source ? { url: origin(source.cameraId, path.rendition) } : { path: source.path }
  }));
  const probes: PlannedProbe[] = mediamtx.probes.map(({ subjectId, cameraId }) => ({
    subjectId,
    url: origin(cameraId, 'default')
  }));
  return { mediamtx: { ...mediamtx, paths, probes }, obs, show };
}

/** The `mediamtx` runtime, with the cameras its paths and probes name. */
interface PlannedGateway {
  configuration: CameraMediamtxConfiguration;
  cameras: PlannedCamera[];
}

/** Who and what the agent reaches: the cameras it controls and pulls from, and the peers it serves. */
interface PlannedReach {
  cameras?: CamerasConfiguration;
  peers: ControllingConfiguration['peers'];
}

/**
 * The `cameras` runtime, for a network's active agent: the cameras on its network, and those `sources` its streams are
 * pulled from, each once; and the peers any agent serves.
 */
async function planReach(device: AuthenticatedDevice, sources: PlannedCamera[]): Promise<PlannedReach> {
  const { peers, local } = await trustedTransaction(
    async () => {
      const networkId = await selectActiveNetwork(device);
      const onNetwork = networkId === undefined ? [] : await selectNetworkCameras(device.organisationId, networkId);
      return { peers: await selectPeers(device), local: onNetwork };
    },
    { name: 'configuration.reach' }
  );
  const cameras = new Map([...sources, ...local].map(camera => [camera.id, camera]));
  if (cameras.size === 0) return { peers };
  const environment = useEnvironment();
  return { cameras: { cameras: [...cameras.values()], grants: { issuer: environment.variables.APP_URL } }, peers };
}

/** The one rendition a preview is published at: the program, as it is encoded (src/gateways/connect.ts). */
const PREVIEW_RENDITION: Rendition = 'default';

/**
 * The `mediamtx` runtime, for the network's active agent on a network with a MediaMTX gateway: its streams' paths and
 * publishers, and a path for each output's preview delivered to its gateway.
 */
async function planMediamtx(device: AuthenticatedDevice): Promise<PlannedGateway | undefined> {
  const planned = await trustedTransaction(
    async () => {
      const gatewayId = await selectLocalGateway(device);
      if (!gatewayId) return undefined;

      const streams = await selectStreams(device.id, gatewayId);
      const gatewayKinds = await selectGatewayKinds(device.organisationId);
      const gateway = await selectGatewayIdentity(gatewayId);
      const address = await selectPreferredAddress(device.id);
      const previews = await selectGatewayPreviews(device.organisationId, gatewayId);
      const configuration = planActiveAgent({
        organisationId: device.organisationId,
        gatewayId,
        gatewayKinds,
        streams
      });
      configuration.previews = previews.map(preview => ({
        name: mediamtxPath(preview.id, PREVIEW_RENDITION),
        previewId: preview.id
      }));
      return { configuration, gateway, address, cameras: sourceCameras(configuration, streams) };
    },
    { name: 'configuration.mediamtx' }
  );
  if (planned === undefined) return undefined;

  const { configuration, gateway, address, cameras } = planned;
  const tls = await ensureGatewayTls(gateway, address);
  if (tls !== undefined) configuration.tls = tls;
  return { configuration, cameras };
}

/** The cameras the planned paths and probes name, as they are registered, each once. */
function sourceCameras(configuration: CameraMediamtxConfiguration, streams: StreamInput[]): PlannedCamera[] {
  const named = new Set(configuration.probes.map(probe => probe.cameraId));
  for (const { source } of configuration.paths) if ('cameraId' in source) named.add(source.cameraId);
  const cameras = new Map<string, PlannedCamera>();
  for (const stream of streams) {
    // Only a stream whose source is a camera something planned names; its credentials only when it has any.
    const camera = stream.sourceDevice?.camera;
    if (stream.sourceDeviceId === null || !camera || !named.has(stream.sourceDeviceId)) continue;
    const { settings, credentials, state } = camera;
    cameras.set(stream.sourceDeviceId, {
      id: stream.sourceDeviceId,
      settings,
      state,
      ...(credentials !== null && { credentials })
    });
  }
  return [...cameras.values()];
}

/** The output's runtimes, for the agent it runs on: `obs`, and `show` while it follows a show. */
interface PlannedOutput {
  obs?: ObsConfiguration;
  show?: ShowConfiguration;
  chat?: ChatConfiguration;
}

/**
 * The `obs` runtime, for an output's agent: the output, how its programme is encoded and where it goes; and the `show`
 * runtime, for the show it follows under `show` control, where the show is followed.
 */
async function planOutput(device: AuthenticatedDevice): Promise<PlannedOutput> {
  const planned = await trustedTransaction(
    async () => {
      const output = await selectDeviceOutput(device.id);
      if (output === undefined) return undefined;
      const plan = await selectOutputPlan(output.outputId);
      const gatewayKinds = await selectGatewayKinds(output.organisationId);
      const commands = await selectListenedCommands(output.organisationId);
      return { output, plan: plan!, gatewayKinds, commands };
    },
    { name: 'configuration.output' }
  );
  if (planned === undefined) return {};
  const { output, plan, gatewayKinds, commands } = planned;
  const { outputId, organisationId, control, showId } = output;
  const { forwards, previews, recorders, ...encoding } = plan;
  const [recorder] = recorders;
  const obs: ObsConfiguration = {
    output: { id: outputId, organisationId, control },
    encoding,
    forwards: forwards.map(forward => ({
      organisationId,
      channelId: forward.channelId,
      forwardId: forward.id,
      stats: forward.channel?.kind === 'twitch'
    })),
    previews: previews.map(preview => ({
      previewId: preview.id,
      gatewayId: preview.gatewayId,
      connect: {
        id: organisationId,
        outputId,
        previewId: preview.id,
        action: 'publish',
        protocol: previewProtocol(preview.gatewayId, gatewayKinds)
      }
    })),
    ...(recorder && { recording: { recorderId: recorder.id, kind: recorder.kind, params: recorder.params } }),
    program: { subjectId: programSubject(outputId) }
  };
  const chat = planChat(organisationId, forwards, commands);
  if (control !== 'show' || showId === null) return { obs, chat };
  const environment = useEnvironment();
  const url = new URL(`/organisations/${organisationId}/shows/${showId}/follow`, environment.variables.APP_URL);
  return { obs, show: { id: showId, url: url.href }, chat };
}

/** An output's forwards, as planning reads them. */
type ForwardInput = NonNullable<Awaited<ReturnType<typeof selectOutputPlan>>>['forwards'][number];

/**
 * The `chat` runtime: the Twitch channels the output goes out to, whose chat is read by the channel's login, and the
 * commands to listen for there. None without both: there is nothing to listen to, or nothing to listen for.
 */
function planChat(
  organisationId: string,
  forwards: ForwardInput[],
  commands: ChatConfiguration['commands']
): ChatConfiguration | undefined {
  const channels: ChatConfiguration['channels'] = [];
  for (const { channelId, channel } of forwards) {
    if (channel?.kind !== 'twitch' || channel.externalLogin === null) continue;
    channels.push({ channelId, platform: 'twitch', login: channel.externalLogin });
  }
  if (channels.length === 0 || commands.length === 0) return undefined;
  return { organisationId, channels, commands };
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

function planActiveAgent(input: PlanningInput): CameraMediamtxConfiguration {
  const paths: CameraPlannedPath[] = [];
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
      if (stream.sourceDeviceId === null || !camera || camera.state !== 'enabled') return feeds;
      return cameraFeeds(exposure, stream.sourceDeviceId, camera);
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
  return { gatewayId: input.gatewayId, auth, paths, publishers, stats, probes: cameraProbes(input.streams) };
}

/**
 * Each camera the agent's streams come from, to probe as it is itself: its `default` rendition, which every driver
 * has. Only while it is enabled; each once, however many streams it is the source of.
 */
function cameraProbes(streams: StreamInput[]): CameraProbe[] {
  const probes = new Map<string, CameraProbe>();
  for (const stream of streams) {
    // Only a stream whose source is a camera that is switched on, and has a rendition of its own to ask for.
    const camera = stream.sourceDevice?.camera;
    if (stream.sourceDeviceId === null || !camera || camera.state !== 'enabled') continue;
    const url = cameraOrigin(camera.settings, camera.credentials ?? undefined, 'default');
    if (url === undefined) continue;
    const subjectId = deviceSubject(stream.sourceDeviceId);
    probes.set(subjectId, { subjectId, cameraId: stream.sourceDeviceId });
  }
  return [...probes.values()];
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
