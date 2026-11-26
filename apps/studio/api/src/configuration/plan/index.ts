import { deviceSubject, programSubject } from '@conservationtv/reports';
import { cameraOrigin } from '@conservationtv/cameras';
import type { AuthenticatedDevice } from '../../middleware/device.ts';
import { trustedTransaction } from '../../db/transaction.ts';
import { ensureGatewayTls } from '../../gateways/certificates.ts';
import { gatewayProvider } from '../../gateways/index.ts';
import { mediamtxPath } from '../../gateways/mediamtx.ts';
import { ONLY_RENDITION } from '../../topology/renditions.ts';
import { useEnvironment } from '../../env/env.ts';
import { selectListenedCommands } from '../../services/chat-commands.ts';
import { selectDeviceOutput, selectOutputPlan } from '../../services/outputs.ts';
import { selectStreamKeyDigests } from '../../services/publishing.ts';
import {
  type ExposureInput,
  type Feed,
  type StreamInput,
  mediamtxAuth,
  selectActiveNetwork,
  selectGatewayIdentity,
  selectGatewayKinds,
  selectGatewaySigners,
  selectGatewayPreviews,
  selectLocalGateway,
  selectNetworkCameras,
  selectPeers,
  selectPreferredAddress,
  selectRelayCoverage,
  selectStreams
} from './helpers.ts';
import type {
  CameraProbe,
  CamerasConfiguration,
  ChatConfiguration,
  ControllingConfiguration,
  DeliveringConfiguration,
  ExposurePublisher,
  ObsConfiguration,
  PlannedCamera,
  PlannedDeviceConfiguration,
  PlannedMediamtxConfiguration,
  PlannedPath,
  PlannedProbe,
  ProbingConfiguration,
  RelaysConfiguration,
  ServedPath,
  ShowConfiguration,
  SignedObsConfiguration
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
// A hop takes its media from its upstream, or with none from the stream's source, which only a camera can be so far;
// a stream with no source is pushed (docs/shows.md, Going live), and its hop with no upstream on the agent's own
// gateway is a path its publisher pushes to: by a token this API signs, or an encoder by the stream's key, which the
// agent is told only the digest of. What the agent does with a hop depends on where it is delivered:
//
//   serves    an exposure of its own gateway: a path, pulled from the camera or the upstream's path;
//   publishes an exposure of another gateway, by MoQ: read from the upstream's path, or one pulling the camera.
//
// Either way an exposure carries the camera's own picture. Smaller pictures beside it, in a MoQ broadcast's catalog,
// are for the publisher to add from what the source can do (docs/shows.md, Delivery): none does yet.
//
// Every exposure of the organisation on a gateway whose relays publish stats is covered by exactly one agent
// (`selectRelayCoverage`): the one that delivers it, else the organisation's oldest active agent. From version 4 that
// agent is given `relays`, where to read the stats and each exposure it covers but does not publish, which it watches
// on the relay, so an exposure a browser publishes straight to the relay is reported about too (docs/shows.md, Health
// and stats without an agent). Versions before 4 follow the stats of the gateways their publishers publish to, and
// report only about those.
//
// The configuration says exactly what the agent runs, MediaMTX paths and MoQ publishers, so the agent decides nothing
// itself. Planning reads the agent's part of the topology, then decides from it alone. What it cannot plan yet
// (smaller pictures, upstreams another device delivers, publishing by other protocols) is left out. Versions before 4
// say the same with each path and publisher at the `default` rendition (`withPathRenditions`).
//
// After the plan, outside its transaction since it waits on the network, the gateway's hostname and certificate
// (src/gateways/certificates.ts): pointed at the agent's preferred address, and issued or renewed when due.

/** The signing device's configuration, read by trusted code: a device principal cannot read the topology. */
export async function planConfiguration(device: AuthenticatedDevice): Promise<PlannedDeviceConfiguration> {
  if (device.kind !== 'agent') {
    throw new Error('Currently planning configuration is only supported for agents.');
  }
  // One after the other: each is a trusted transaction, on the one admin connection.
  const gateway = await planMediamtx(device);
  const relays = await planRelays(device, gateway?.configuration.publishers ?? []);
  const { obs, show, chat } = await planOutput(device);
  const { cameras, peers } = await planReach(device, gateway?.cameras ?? []);
  return { mediamtx: gateway?.configuration, relays, cameras, obs, show, chat, peers };
}

/** The configuration as version 4 returns it: where to read the relays' stats is `relays`'s alone. */
export function withRelays(configuration: PlannedDeviceConfiguration): DeliveringConfiguration {
  const { mediamtx, ...rest } = configuration;
  if (mediamtx === undefined) return rest;
  const { stats: _stats, ...delivering } = mediamtx;
  return { ...rest, mediamtx: delivering };
}

/**
 * The configuration as version 3 returns it: each path delivering its exposure's `default` rendition, and each
 * publisher publishing that one rendition from it, which agents from before version 4 join into the broadcast readers
 * watch, as they would several.
 */
export function withPathRenditions(configuration: PlannedDeviceConfiguration): ControllingConfiguration {
  // Those agents follow the stats of the gateways they publish to, and watch nothing: `relays` is not theirs.
  const { mediamtx, relays: _relays, ...rest } = configuration;
  if (mediamtx === undefined) return rest;
  // Those agents pull every path from somewhere: a pushed one, and whatever publishes from it, is left out.
  const pushed = new Set(mediamtx.paths.filter(path => 'push' in path.source).map(path => path.name));
  const paths = mediamtx.paths.flatMap(({ source, ...path }) =>
    'push' in source ? [] : [{ ...path, source, rendition: ONLY_RENDITION }]
  );
  const read = mediamtx.publishers.filter(publisher => !pushed.has(publisher.path));
  const publishers = read.map(({ exposureId, connect, path }) => ({
    exposureId,
    connect,
    layout: 'tracks' as const,
    renditions: [{ rendition: ONLY_RENDITION, path }]
  }));
  return { ...rest, mediamtx: { ...mediamtx, paths, publishers } };
}

/**
 * The configuration as versions before 3 return it: each camera a path is pulled from, or probed at, as the URL its
 * driver gives, credentials included, which those agents pull as it is; and without what they don't read.
 */
export function withCameraUrls(configuration: ControllingConfiguration): ProbingConfiguration {
  const { mediamtx, show } = configuration;
  const obs = configuration.obs && withoutSigners(configuration.obs);
  if (mediamtx === undefined) return { obs, show };
  const cameras = new Map((configuration.cameras?.cameras ?? []).map(camera => [camera.id, camera]));
  const origin = (cameraId: string) => {
    const camera = cameras.get(cameraId)!;
    return cameraOrigin(camera.settings, camera.credentials);
  };
  const paths: PlannedPath[] = mediamtx.paths.map(({ source, ...path }) => ({
    ...path,
    source: 'cameraId' in source ? { url: origin(source.cameraId) } : { path: source.path }
  }));
  const probes: PlannedProbe[] = mediamtx.probes.map(({ subjectId, cameraId }) => ({
    subjectId,
    url: origin(cameraId)
  }));
  return { mediamtx: { ...mediamtx, paths, probes }, obs, show };
}

/** The `obs` runtime as versions before 3 return it: as it was before previews said who signs their tokens. */
function withoutSigners(obs: SignedObsConfiguration): ObsConfiguration {
  const previews = obs.previews.map(({ previewId, gatewayId, connect }) => ({ previewId, gatewayId, connect }));
  return { ...obs, previews };
}

/** The `mediamtx` runtime, with the cameras its paths and probes name. */
interface PlannedGateway {
  configuration: PlannedMediamtxConfiguration;
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
      const pushed = streams.filter(stream => stream.sourceDeviceId === null).map(stream => stream.id);
      const keyDigests = await selectStreamKeyDigests(pushed);
      const gatewayKinds = await selectGatewayKinds(device.organisationId);
      const gateway = await selectGatewayIdentity(gatewayId);
      const address = await selectPreferredAddress(device.id);
      const previews = await selectGatewayPreviews(device.organisationId, gatewayId);
      const configuration = planActiveAgent({
        organisationId: device.organisationId,
        gatewayId,
        gatewayKinds,
        streams,
        keyDigests
      });
      configuration.previews = previews.map(preview => ({
        name: mediamtxPath(preview.id),
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
function sourceCameras(configuration: PlannedMediamtxConfiguration, streams: StreamInput[]): PlannedCamera[] {
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

/**
 * The `relays` runtime, for an agent that covers some of its organisation's exposures on a gateway whose relays publish
 * stats (`selectRelayCoverage`): each such gateway's stats, once, and each exposure it covers that `publishers` does not
 * publish, to watch on the relay. None for an agent that covers nothing.
 */
async function planRelays(
  device: AuthenticatedDevice,
  publishers: ExposurePublisher[]
): Promise<RelaysConfiguration | undefined> {
  const coverage = await trustedTransaction(() => selectRelayCoverage(device.organisationId), {
    name: 'configuration.relays'
  });
  const covered = coverage.filter(exposure => exposure.coveredBy === device.id);
  if (covered.length === 0) return undefined;
  const published = new Set(publishers.map(publisher => publisher.exposureId));
  const gatewayIds = [...new Set(covered.map(exposure => exposure.gatewayId))];
  const stats = gatewayIds.map(gatewayId => ({ id: device.organisationId, gatewayId }));
  const watched = covered
    .filter(exposure => !published.has(exposure.id))
    .map(exposure => ({
      exposureId: exposure.id,
      connect: {
        id: device.organisationId,
        streamId: exposure.streamId,
        exposureId: exposure.id,
        action: 'read' as const,
        protocol: 'moq' as const
      }
    }));
  return { stats, watched };
}

/** The output's runtimes, for the agent it runs on: `obs`, and `show` while it follows a show. */
interface PlannedOutput {
  obs?: SignedObsConfiguration;
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
      const signers = await selectGatewaySigners(output.organisationId);
      return { output, plan: plan!, gatewayKinds, commands, signers };
    },
    { name: 'configuration.output' }
  );
  if (planned === undefined) return {};
  const { output, plan, gatewayKinds, commands, signers } = planned;
  const { outputId, organisationId, control, showId } = output;
  const { forwards, previews, recorders, ...encoding } = plan;
  const [recorder] = recorders;
  const obs: SignedObsConfiguration = {
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
      signer: signers.get(preview.gatewayId) ?? null,
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

/** How an output publishes a preview: by MoQ to a gateway that takes it, otherwise RTMP. */
function previewProtocol(gatewayId: string, gatewayKinds: Map<string, string>) {
  const provider = gatewayProvider(gatewayId, gatewayKinds.get(gatewayId) ?? '');
  return provider.ingest.includes('moq') ? 'moq' : 'rtmp';
}

/** What planning an active agent decides from: its MediaMTX gateway, and each stream it delivers some of. */
interface PlanningInput {
  organisationId: string;
  gatewayId: string;
  /** The kind of each of the organisation's own gateways, by ID. */
  gatewayKinds: Map<string, string>;
  streams: StreamInput[];
  /** The digest of each pushed stream's key, by stream ID: none for a stream without one. */
  keyDigests: Map<string, string>;
}

function planActiveAgent(input: PlanningInput): PlannedMediamtxConfiguration {
  const paths: ServedPath[] = [];
  const publishers: ExposurePublisher[] = [];
  const auth = mediamtxAuth(input.gatewayId);

  for (const stream of input.streams) {
    const exposures = new Map(stream.exposures.map(exposure => [exposure.id, exposure]));
    // Each exposure planned so far, by ID: the path it is read from on this MediaMTX, or null for none. Hops are
    // planned upstream first, whichever order they come in; the routes refuse a chain that loops.
    const planned = new Map<string, string | null>();

    /**
     * Plans the hop once: from its feed, onto a path of the hop's own when it is served or pulled to be published, or
     * straight from its upstream's path when published; then its publisher, when it has a path to read.
     */
    const plan = (exposure: ExposureInput): string | null => {
      const done = planned.get(exposure.id);
      if (done !== undefined) return done;
      planned.set(exposure.id, null);
      const serves = exposure.gatewayId === input.gatewayId;
      if (!serves && !publishesByMoq(exposure)) return null;
      const feed = feedOf(exposure);
      if (feed === undefined) return null;

      // A publisher reads an upstream's path as it is; anything else is a path of the exposure's own.
      let local = !serves && 'path' in feed ? feed.path : null;
      if (local === null) {
        local = mediamtxPath(exposure.id);
        paths.push({ name: local, exposureId: exposure.id, source: feed });
      }
      planned.set(exposure.id, local);

      if (!serves) {
        publishers.push({
          exposureId: exposure.id,
          connect: {
            id: input.organisationId,
            streamId: stream.id,
            exposureId: exposure.id,
            action: 'publish',
            protocol: 'moq'
          },
          path: local
        });
      }
      return local;
    };

    /** Where the hop comes from: its upstream's path if it has one, otherwise the stream's source. */
    const feedOf = (exposure: ExposureInput): Feed | undefined => {
      if (exposure.upstreamExposureId !== null) {
        const upstream = exposures.get(exposure.upstreamExposureId);
        // TODO: Read an upstream another device delivers, by `connect` (action: 'read').
        if (upstream === undefined) return undefined;
        const path = plan(upstream);
        return path === null ? undefined : { path };
      }
      // A stream with no source is pushed to its ingest on this gateway, by a token or the stream's key.
      if (stream.sourceDeviceId === null) return pushFeed(exposure);
      // Only a camera can be pulled from, and only while it is enabled.
      const camera = stream.sourceDevice?.camera;
      if (!camera || camera.state !== 'enabled') return undefined;
      return { cameraId: stream.sourceDeviceId };
    };

    /** A pushed stream's ingest, served by this agent's gateway, with its key's digest; none on another gateway. */
    const pushFeed = (exposure: ExposureInput): Feed | undefined => {
      if (exposure.gatewayId !== input.gatewayId) return undefined;
      return { push: { keySha256: input.keyDigests.get(stream.id) ?? null } };
    };

    /** Whether the hop's gateway takes it by MoQ, the only protocol agents publish by. */
    const publishesByMoq = (exposure: ExposureInput) => {
      const provider = gatewayProvider(exposure.gatewayId, input.gatewayKinds.get(exposure.gatewayId) ?? '');
      return provider.ingest.includes('moq');
    };

    for (const exposure of stream.exposures) plan(exposure);
  }

  const stats = statsGateways(input, publishers).map(gatewayId => ({ id: input.organisationId, gatewayId }));
  return { gatewayId: input.gatewayId, auth, paths, publishers, stats, probes: cameraProbes(input.streams) };
}

/**
 * Each camera the agent's streams come from, to probe as it is itself: its own picture, which every driver has. Only
 * while it is enabled; each once, however many streams it is the source of.
 */
function cameraProbes(streams: StreamInput[]): CameraProbe[] {
  const probes = new Map<string, CameraProbe>();
  for (const stream of streams) {
    // Only a stream whose source is a camera that is switched on.
    const camera = stream.sourceDevice?.camera;
    if (stream.sourceDeviceId === null || !camera || camera.state !== 'enabled') continue;
    const subjectId = deviceSubject(stream.sourceDeviceId);
    probes.set(subjectId, { subjectId, cameraId: stream.sourceDeviceId });
  }
  return [...probes.values()];
}

/**
 * The gateways the agent publishes to whose relays publish the traffic stats of what they carry, each once: what
 * versions before 4 follow.
 */
function statsGateways(input: PlanningInput, publishers: ExposurePublisher[]): string[] {
  const published = new Set(publishers.map(publisher => publisher.exposureId));
  const gateways = input.streams
    .flatMap(stream => stream.exposures)
    .filter(exposure => published.has(exposure.id))
    .map(exposure => exposure.gatewayId)
    .filter(gatewayId => gatewayProvider(gatewayId, input.gatewayKinds.get(gatewayId) ?? '').stats !== undefined);
  return [...new Set(gateways)];
}
