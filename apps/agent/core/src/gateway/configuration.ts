import type { Client } from '@conservationtv/studio-sdk';
import { getLogger } from '@logtape/logtape';
import { REPORT_INTERVAL_MS } from '../reporting/sampler.ts';
import { type DeviceConfiguration, keepLeases, leased, withToken } from '../studio.ts';
import type { MetricsSpec } from './metrics/runtime.ts';
import type { RelayStatsSource, RelayTrafficSpec, WatchedBroadcast } from './relay-traffic/runtime.ts';
import type { MoqPublisher } from './streams/config.ts';
import type { StreamsSpec } from './streams/runtime.ts';

// The gateway's keys, from the configuration's `mediamtx` and `relays` sections (system/configuration.ts):
//
//   streams       the gateway it runs, whose endpoints it registers while it serves, the paths it names, as they are,
//                 the certificate it names for the gateway's hostname, and each publisher it names, with where to
//                 publish from `organisations.streams.exposures.connect`;
//   metrics       what each path delivers;
//   relayTraffic  from `relays`: where to read the relays' stats of what they carry from
//                 `organisations.gateways.stats.connect`, each exposure the agent covers by the path its broadcast is
//                 at, without the URL or its token, and each it covers but does not publish, to watch on the relay.
//
// The studio API has every exposure of the organisation on such a relay covered by exactly one agent: the one that
// publishes it, otherwise one it picks (docs/shows.md, Health and stats without an agent). An agent that runs no
// gateway may have `relays` alone.
//
// A publisher reads its path on this machine, which needs no token (streams/auth.ts), and publishes it to the relay
// with credentials from `organisations.streams.exposures.connect`; a watched exposure is read with a read credential
// from it, for its catalog alone. Those, and the stats', are kept until shortly before they expire. A renewal changes
// the spec: the relays' traffic follows a renewed stats URL afresh, and has no rates for a sample or two after it, and
// a renewed watch carries on with its new token (relay-traffic/runtime.ts). Leases for what the configuration no longer
// names are forgotten with each pass.

const logger = getLogger(['agent', 'studio']);

/** The configuration's `mediamtx` section. */
type MediamtxSection = NonNullable<DeviceConfiguration['mediamtx']>;

/** The configuration's `relays` section. */
type RelaysSection = NonNullable<DeviceConfiguration['relays']>;

/** The gateway's keys' specs, from the `mediamtx` section. */
export interface GatewaySpecs {
  streams: StreamsSpec;
  metrics: MetricsSpec;
}

/** The connection details `connect` returns, whichever protocol. */
type Connection = Exclude<Awaited<ReturnType<Client['organisations']['streams']['exposures']['connect']['v2']>>, Error>;

/** Where `stats.connect` says to read a gateway's traffic stats. */
type StatsConnection = Exclude<
  Awaited<ReturnType<Client['organisations']['gateways']['stats']['connect']['v1']>>,
  Error
>;

/**
 * The credentials kept between asks, each until shortly before it expires: from `connect`, to publish each exposure,
 * and to watch each the agent covers but does not publish, by its ID; and from `stats.connect`, to read each gateway's
 * stats, by the gateway's ID.
 */
export interface GatewayLeases {
  publish: Map<string, Connection>;
  watch: Map<string, Connection>;
  stats: Map<string, StatsConnection>;
}

/**
 * The `streams` and `metrics` specs of the `mediamtx` section: its paths as they are, each publisher with where to
 * publish from `connect`, and the metrics of each path about what it delivers.
 */
export async function gatewaySpecs(
  mediamtx: MediamtxSection,
  studio: Client,
  leases: GatewayLeases
): Promise<GatewaySpecs> {
  keepLeases(
    leases.publish,
    mediamtx.publishers.map(({ connect }) => connect.exposureId)
  );
  const publishers: MoqPublisher[] = [];
  for (const { exposureId, connect: ask, path } of mediamtx.publishers) {
    // One whose credentials cannot be had is left out, and tried again next time.
    try {
      const connect = await publishTarget(studio, leases.publish, ask);
      publishers.push({ exposureId, ...connect, path });
    } catch (error) {
      logger.error('Publisher {exposureId} is unavailable: {error}', { exposureId, error });
    }
  }
  const { gatewayId, auth, tls, paths } = mediamtx;
  const previews = mediamtx.previews ?? [];
  const streams: StreamsSpec = { gatewayId, paths, previews, auth, tls, publishers };
  const attributions = paths.map(({ name, exposureId }) => ({ name, exposureId }));
  const metrics: MetricsSpec = { intervalMs: REPORT_INTERVAL_MS, paths: attributions };
  return { streams, metrics };
}

/**
 * The `relayTraffic` key's spec, of the `relays` section: the relays' stats to read, from `stats.connect`; each
 * exposure the agent covers by the path its broadcast is beneath on the relay, of those it publishes (`publishers`,
 * the `streams` spec's) and those it watches; and each it watches, with where to read it from `connect`. Absent
 * without a section, or with nothing to read. With stats but no exposures, as when none's credentials could be had
 * this time, the relays are still followed: finalising would drop what is pending and the counters the next rates are
 * measured from, for exposures that are back with the next ask.
 */
export async function relayTrafficSpec(
  relays: RelaysSection | undefined,
  publishers: MoqPublisher[],
  studio: Client,
  leases: GatewayLeases
): Promise<RelayTrafficSpec | undefined> {
  keepRelayLeases(relays, leases);
  if (relays === undefined) return undefined;
  const sources: RelayStatsSource[] = [];
  for (const ask of relays.stats) {
    // A gateway whose stats cannot be read is left out, and tried again next time: publishing goes on regardless.
    try {
      sources.push({ connect: await statsTarget(studio, leases.stats, ask) });
    } catch (error) {
      logger.error('The stats of gateway {gatewayId} are unavailable: {error}', { gatewayId: ask.gatewayId, error });
    }
  }
  const watched: WatchedBroadcast[] = [];
  for (const { exposureId, connect: ask } of relays.watched) {
    // One whose credentials cannot be had is left out, and tried again next time.
    try {
      watched.push({ exposureId, ...(await watchTarget(studio, leases.watch, ask)) });
    } catch (error) {
      logger.error('Watching {exposureId} on the relay is unavailable: {error}', { exposureId, error });
    }
  }
  if (sources.length === 0 && watched.length === 0) return undefined;
  const covered = [...publishers, ...watched];
  const exposures = covered.map(({ exposureId, connect }) => ({ exposureId, prefix: `${pathOf(connect)}/` }));
  return { sources, exposures, watched };
}

/** Forgets the stats and watch leases of what the `relays` section, if any, no longer names. */
function keepRelayLeases(relays: RelaysSection | undefined, leases: GatewayLeases): void {
  const stats = relays?.stats ?? [];
  const watched = relays?.watched ?? [];
  keepLeases(
    leases.stats,
    stats.map(({ gatewayId }) => gatewayId)
  );
  keepLeases(
    leases.watch,
    watched.map(({ connect }) => connect.exposureId)
  );
}

/** The path a URL is dialed at, without its slashes: where a publisher's broadcast is on the relay. */
function pathOf(url: string): string {
  const { pathname } = new URL(url);
  return pathname.replace(/^\/+/, '').replace(/\/+$/, '');
}

/** The `connect` ask the configuration gives for where to publish an exposure. */
type PublisherConnect = MediamtxSection['publishers'][number]['connect'];

/** The `connect` ask the configuration gives for where to watch an exposure the agent covers but does not publish. */
type WatchConnect = RelaysSection['watched'][number]['connect'];

/**
 * Where to read the exposure's catalog back through the relay: the relay URL to dial at its path, carrying its read
 * token as `?jwt=`, and the broadcast under it, from the lease `connect` gives; throws if it refuses, or the exposure is
 * not read by MoQ.
 */
async function watchTarget(studio: Client, connections: GatewayLeases['watch'], ask: WatchConnect) {
  const connect = studio.organisations.streams.exposures.connect;
  const connection = await leased(connections, ask.exposureId, () => connect.v2(ask));
  if (!('relay' in connection)) throw new Error(`Exposure ${ask.exposureId} is not read by MoQ`);
  const url = new URL(connection.path, connection.relay);
  return { connect: withToken(url, connection.token), broadcast: connection.broadcast };
}

/**
 * Where to publish the exposure: the relay URL to dial at its path, carrying its token as `?jwt=`, which the relay
 * reads, and the broadcast under it, from the lease `connect` gives (studio.ts); throws if it refuses, or the exposure
 * is not published by MoQ.
 */
async function publishTarget(studio: Client, connections: GatewayLeases['publish'], ask: PublisherConnect) {
  // Version 1 for an API from before an exposure stopped naming its renditions, which answers the same but for those.
  const { connect } = studio.organisations.streams.exposures;
  const renew = () => (connect.version === 2 ? connect.v2(ask) : connect.v1(ask));
  const connection = await leased(connections, ask.exposureId, renew);
  if (!('relay' in connection)) throw new Error(`Exposure ${ask.exposureId} is not published by MoQ`);
  const url = new URL(connection.path, connection.relay);
  return { connect: withToken(url, connection.token), broadcast: connection.broadcast };
}

/** The `stats.connect` ask the configuration gives for where to read a gateway's traffic stats. */
type StatsConnect = RelaysSection['stats'][number];

/**
 * Where to read the gateway's traffic stats: the relay URL to dial at the stats path, carrying its token as `?jwt=`,
 * from the lease `stats.connect` gives (studio.ts); throws if it refuses.
 */
async function statsTarget(studio: Client, connections: GatewayLeases['stats'], ask: StatsConnect) {
  const renew = () => studio.organisations.gateways.stats.connect.v1(ask);
  const connection = await leased(connections, ask.gatewayId, renew);
  const url = new URL(connection.path, connection.relay);
  return withToken(url, connection.token);
}
