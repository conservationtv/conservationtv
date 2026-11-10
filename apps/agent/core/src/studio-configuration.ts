import { setTimeout as sleep } from 'node:timers/promises';
import type { Client } from '@conservationtv/studio-sdk';
import { getLogger } from '@logtape/logtape';
import type { ChannelsSpec, ReportedChannel } from './runtimes/channel-stats.ts';
import type { MetricsSpec, MoqPublisher, StreamsSpec } from './runtimes/mediamtx/index.ts';
import type { ObsSpec } from './runtimes/obs/index.ts';
import type { RelayStatsSource, RelayTrafficSpec } from './runtimes/relay-traffic.ts';
import { useStudio } from './studio.ts';

// How a conservation.tv agent learns what to run. Every `INTERVAL_MS` it:
//
//   1. asks the studio API for its configuration (`deviceConfiguration.get`, signed as the agent's device): a section
//      for each runtime it is to run, and none for those it isn't;
//   2. turns its `mediamtx` section into the spec for its streams: the gateway it runs, whose endpoints it registers
//      while it serves, the paths it names, as they are, the certificate it names for the gateway's hostname, and each
//      publisher it names, with where to publish from `organisations.streams.exposures.connect`; for its metrics: what
//      each path delivers; and for the relays' traffic: where to read the relays' stats of what they carry from
//      `organisations.gateways.stats.connect`, and each publisher's exposure by the path it publishes at, without the
//      URL or its token;
//   3. turns its `obs` section, the show it sends out, into the `obs` key's spec: as it is, but for each preview, with
//      where to publish it from `organisations.shows.previews.connect`; and its forwards whose channels have stats
//      into the `channels` key's, each channel once, which the runtime reads with `organisations.channels.stats.get`
//      as it reports, so no credential is kept for them;
//   4. hands them to converge as the `streams`, `metrics`, `relayTraffic`, `obs` and `channels` keys, each of which
//      changes what runs only when its spec changed, and is finalised when its section is left out, or, for
//      `relayTraffic` and `channels`, when it has nothing to read.
//
// A publisher reads its renditions on this machine, which needs no token (runtimes/mediamtx/auth.ts), and publishes
// them to the relay with credentials from `organisations.streams.exposures.connect`; a preview, the program, with
// credentials from `organisations.shows.previews.connect`. Those are kept until shortly before they expire, so the
// spec, and the processes run from it, stay the same between renewals. A renewal changes the spec: the relays' traffic
// follows a renewed stats URL afresh, carrying its counters on (runtimes/relay-traffic.ts).
//
// TODO: Be told of changes rather than polling, once the studio API can push them.

/** How often the agent asks for its configuration. */
const INTERVAL_MS = 30_000;

/** How often the streams' metrics are shipped. */
const METRICS_INTERVAL_MS = 60_000;

/** How long before a credential expires it is renewed. Longer than `INTERVAL_MS`, so one ask always catches it. */
const RENEW_BEFORE_MS = 10 * 60_000;

const logger = getLogger(['agent', 'studio']);

/** The specs the configuration gives each key: absent for a runtime it leaves out. */
export interface StudioSpecs {
  streams?: StreamsSpec;
  metrics?: MetricsSpec;
  relayTraffic?: RelayTrafficSpec;
  obs?: ObsSpec;
  channels?: ChannelsSpec;
}

/** What converge is told: each key's spec, or that it is absent. */
export type ApplyStudioSpecs = (specs: StudioSpecs) => Promise<void>;

/**
 * Ask for the configuration now and every `INTERVAL_MS` until `signal` aborts, applying each answer. A failed ask
 * keeps the spec as it was, and is tried again next time. Resolves once stopped.
 */
export async function watchStudioConfiguration(signal: AbortSignal, apply: ApplyStudioSpecs): Promise<void> {
  const studio = useStudio();
  const connections: Connections = { publish: new Map(), stats: new Map(), previews: new Map() };
  while (!signal.aborted) {
    try {
      const configuration = await askConfiguration(studio);
      await apply(await studioSpecs(configuration, studio, connections));
    } catch (error) {
      // Stopping aborts whatever ask is in flight: that is no failure.
      if (!signal.aborted) logger.error('Asking for the configuration failed: {error}', { error });
    }
    await sleep(INTERVAL_MS, undefined, { signal }).catch(() => undefined);
  }
}

/** One answer from the studio API, signed as the agent's device. */
async function askConfiguration(studio: Client) {
  await studio.handshake();
  const configuration = await studio.deviceConfiguration.get.v1();
  if (configuration instanceof Error) throw configuration;
  return configuration;
}

/** The spec of each key the configuration has a section for. */
async function studioSpecs(
  configuration: DeviceConfiguration,
  studio: Client,
  connections: Connections
): Promise<StudioSpecs> {
  const specs: StudioSpecs = {};
  if (configuration.mediamtx !== undefined) {
    const { streams, metrics, relayTraffic } = await mediamtxSpecs(configuration.mediamtx, studio, connections);
    specs.streams = streams;
    specs.metrics = metrics;
    specs.relayTraffic = relayTraffic;
  }
  if (configuration.obs !== undefined) {
    specs.obs = await obsSpec(configuration.obs, studio, connections);
    specs.channels = channelsSpec(configuration.obs);
  }
  return specs;
}

/** The `channels` key's spec: each channel the `obs` section forwards to that has stats, once; absent for none. */
function channelsSpec(obs: ObsSection): ChannelsSpec | undefined {
  const channels = new Map<string, ReportedChannel>();
  for (const { organisationId, channelId, stats } of obs.forwards) {
    if (stats === true) channels.set(channelId, { organisationId, channelId });
  }
  if (channels.size === 0) return undefined;
  return { channels: [...channels.values()] };
}

/** The `obs` key's spec from the `obs` section: as it is, but for each preview, with where to publish it. */
async function obsSpec(obs: ObsSection, studio: Client, connections: Connections): Promise<ObsSpec> {
  const previews: ObsSpec['previews'] = [];
  for (const { previewId, connect: ask } of obs.previews ?? []) {
    // One whose credentials cannot be had is left out, and tried again next time.
    try {
      const publish = await previewTarget(studio, connections.previews, ask);
      previews.push({ previewId, publish });
    } catch (error) {
      logger.error('Preview {previewId} is unavailable: {error}', { previewId, error });
    }
  }
  const { show, output, forwards, recording, program } = obs;
  return { show, output, forwards, previews, recording, program };
}

/**
 * The `streams`, `metrics` and `relayTraffic` specs of the `mediamtx` section: its paths as they are, each publisher
 * with where to publish from `connect`, the metrics of each path about what it delivers, and the relays' traffic of
 * each publisher's exposure, read from `stats.connect`.
 */
async function mediamtxSpecs(mediamtx: MediamtxSection, studio: Client, connections: Connections) {
  const publishers: MoqPublisher[] = [];
  for (const { exposureId, connect: ask, layout, renditions } of mediamtx.publishers) {
    // One whose credentials cannot be had is left out, and tried again next time.
    try {
      const connect = await publishTarget(studio, connections.publish, ask);
      publishers.push({ exposureId, ...connect, layout, renditions });
    } catch (error) {
      logger.error('Publisher {exposureId} is unavailable: {error}', { exposureId, error });
    }
  }
  const stats: RelayStatsSource[] = [];
  for (const ask of mediamtx.stats) {
    // A gateway whose stats cannot be read is left out, and tried again next time: publishing goes on regardless.
    try {
      stats.push({ connect: await statsTarget(studio, connections.stats, ask) });
    } catch (error) {
      logger.error('The stats of gateway {gatewayId} are unavailable: {error}', { gatewayId: ask.gatewayId, error });
    }
  }
  const { gatewayId, auth, tls, paths } = mediamtx;
  const previews = mediamtx.previews ?? [];
  const streams: StreamsSpec = { gatewayId, paths, previews, auth, tls, publishers };
  const attributions = paths.map(({ name, exposureId, rendition }) => ({ name, exposureId, rendition }));
  const metrics: MetricsSpec = { intervalMs: METRICS_INTERVAL_MS, paths: attributions };
  const relayTraffic = relayTrafficSpec(stats, publishers);
  return { streams, metrics, relayTraffic };
}

/**
 * The `relayTraffic` key's spec: the relays' stats to read, and each publisher's exposure by the path its broadcasts
 * are beneath on the relay. Absent without either: there is nothing to read, or nothing to report about.
 */
function relayTrafficSpec(sources: RelayStatsSource[], publishers: MoqPublisher[]): RelayTrafficSpec | undefined {
  if (sources.length === 0 || publishers.length === 0) return undefined;
  const exposures = publishers.map(({ exposureId, connect }) => ({ exposureId, prefix: `${pathOf(connect)}/` }));
  return { sources, exposures };
}

/** The path a URL is dialed at, without its slashes: where a publisher's broadcasts are on the relay. */
function pathOf(url: string): string {
  const { pathname } = new URL(url);
  return pathname.replace(/^\/+/, '').replace(/\/+$/, '');
}

/** The configuration `deviceConfiguration.get` returns. */
type DeviceConfiguration = Exclude<Awaited<ReturnType<Client['deviceConfiguration']['get']['v1']>>, Error>;

/** Its `mediamtx` section. */
type MediamtxSection = NonNullable<DeviceConfiguration['mediamtx']>;

/** Its `obs` section. */
type ObsSection = NonNullable<DeviceConfiguration['obs']>;

/** The connection details `connect` returns, whichever protocol. */
type Connection = Exclude<Awaited<ReturnType<Client['organisations']['streams']['exposures']['connect']['v1']>>, Error>;

/** Where `stats.connect` says to read a gateway's traffic stats. */
type StatsConnection = Exclude<
  Awaited<ReturnType<Client['organisations']['gateways']['stats']['connect']['v1']>>,
  Error
>;

/** The connection details `organisations.shows.previews.connect` returns, whichever protocol. */
type PreviewConnection = Exclude<
  Awaited<ReturnType<Client['organisations']['shows']['previews']['connect']['v1']>>,
  Error
>;

/**
 * The credentials kept between asks, each until shortly before it expires: from `connect`, to publish each exposure,
 * by its ID; from `stats.connect`, to read each gateway's stats, by the gateway's ID; and from `previews.connect`, to
 * publish each preview, by its ID.
 */
interface Connections {
  publish: Map<string, Connection>;
  stats: Map<string, StatsConnection>;
  previews: Map<string, PreviewConnection>;
}

/** The `connect` ask the configuration gives for where to publish an exposure. */
type PublisherConnect = MediamtxSection['publishers'][number]['connect'];

/**
 * Where to publish the exposure: the relay URL to dial at its path, carrying its token as `?jwt=`, which the relay
 * reads, and the broadcast under it. Asks `connect` again when what is kept expires within `RENEW_BEFORE_MS`; throws
 * if it refuses, or the exposure is not published by MoQ.
 */
async function publishTarget(studio: Client, connections: Connections['publish'], ask: PublisherConnect) {
  let connection = connections.get(ask.exposureId);
  const expiresAt = connection?.expiresAt === undefined ? Infinity : Date.parse(connection.expiresAt);
  if (connection === undefined || expiresAt - Date.now() < RENEW_BEFORE_MS) {
    const renewed = await studio.organisations.streams.exposures.connect.v1(ask);
    if (renewed instanceof Error) throw renewed;
    connections.set(ask.exposureId, renewed);
    connection = renewed;
  }
  if (!('relay' in connection)) throw new Error(`Exposure ${ask.exposureId} is not published by MoQ`);
  const url = new URL(connection.path, connection.relay);
  if (connection.token !== undefined) url.searchParams.set('jwt', connection.token);
  return { connect: url.href, broadcast: connection.broadcast };
}

/** The `previews.connect` ask the configuration gives for where to publish a preview. */
type PreviewConnect = NonNullable<ObsSection['previews']>[number]['connect'];

/**
 * Where to publish the preview: by MoQ, the relay URL to dial at its path, carrying its token as `?jwt=`, and the
 * broadcast under it; by RTMP(S), the URL to push to, carrying its token as `?jwt=`. Asks `previews.connect` again
 * when what is kept expires within `RENEW_BEFORE_MS`; throws if it refuses, or offers a protocol the agent can't push.
 */
async function previewTarget(
  studio: Client,
  connections: Connections['previews'],
  ask: PreviewConnect
): Promise<ObsSpec['previews'][number]['publish']> {
  const connection = await previewConnection(studio, connections, ask);
  if ('relay' in connection) {
    const url = new URL(connection.path, connection.relay);
    if (connection.token !== undefined) url.searchParams.set('jwt', connection.token);
    return { protocol: 'moq', connect: url.href, broadcast: connection.broadcast };
  }
  const { protocol } = connection;
  if (protocol !== 'rtmp' && protocol !== 'rtmps') throw new Error(`Preview ${ask.previewId} is not pushed by RTMP`);
  const url = new URL(connection.url);
  if (connection.token !== undefined) url.searchParams.set('jwt', connection.token);
  return { protocol, url: url.href };
}

/** The preview's connection: the one kept, or asked for again when it expires within `RENEW_BEFORE_MS`. */
async function previewConnection(studio: Client, connections: Connections['previews'], ask: PreviewConnect) {
  const kept = connections.get(ask.previewId);
  const expiresAt = kept?.expiresAt === undefined ? Infinity : Date.parse(kept.expiresAt);
  if (kept !== undefined && expiresAt - Date.now() >= RENEW_BEFORE_MS) return kept;
  const renewed = await studio.organisations.shows.previews.connect.v1(ask);
  if (renewed instanceof Error) throw renewed;
  connections.set(ask.previewId, renewed);
  return renewed;
}

/** The `stats.connect` ask the configuration gives for where to read a gateway's traffic stats. */
type StatsConnect = MediamtxSection['stats'][number];

/**
 * Where to read the gateway's traffic stats: the relay URL to dial at the stats path, carrying its token as `?jwt=`.
 * Asks `stats.connect` again when what is kept expires within `RENEW_BEFORE_MS`; throws if it refuses.
 */
async function statsTarget(studio: Client, connections: Connections['stats'], ask: StatsConnect) {
  let connection = connections.get(ask.gatewayId);
  const expiresAt = connection?.expiresAt === undefined ? Infinity : Date.parse(connection.expiresAt);
  if (connection === undefined || expiresAt - Date.now() < RENEW_BEFORE_MS) {
    const renewed = await studio.organisations.gateways.stats.connect.v1(ask);
    if (renewed instanceof Error) throw renewed;
    connections.set(ask.gatewayId, renewed);
    connection = renewed;
  }
  const url = new URL(connection.path, connection.relay);
  if (connection.token !== undefined) url.searchParams.set('jwt', connection.token);
  return url.href;
}
