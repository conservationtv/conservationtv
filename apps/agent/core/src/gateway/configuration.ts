import type { Client } from '@conservationtv/studio-sdk';
import { getLogger } from '@logtape/logtape';
import { REPORT_INTERVAL_MS } from '../reporting/sampler.ts';
import { type DeviceConfiguration, leased, withToken } from '../studio.ts';
import type { MetricsSpec } from './metrics/runtime.ts';
import type { RelayStatsSource, RelayTrafficSpec } from './relay-traffic/runtime.ts';
import type { MoqPublisher } from './streams/config.ts';
import type { StreamsSpec } from './streams/runtime.ts';

// The gateway's keys, from the configuration's `mediamtx` section (system/configuration.ts):
//
//   streams       the gateway it runs, whose endpoints it registers while it serves, the paths it names, as they are,
//                 the certificate it names for the gateway's hostname, and each publisher it names, with where to
//                 publish from `organisations.streams.exposures.connect`;
//   metrics       what each path delivers;
//   relayTraffic  where to read the relays' stats of what they carry from `organisations.gateways.stats.connect`, and
//                 each publisher's exposure by the path it publishes at, without the URL or its token.
//
// A publisher reads its renditions on this machine, which needs no token (streams/auth.ts), and publishes them to the
// relay with credentials from `organisations.streams.exposures.connect`. Those, and the stats', are kept until shortly
// before they expire. A renewal changes the spec: the relays' traffic follows a renewed stats URL afresh, and has no
// rates for a sample or two after it (relay-traffic/runtime.ts).

const logger = getLogger(['agent', 'studio']);

/** The configuration's `mediamtx` section. */
type MediamtxSection = NonNullable<DeviceConfiguration['mediamtx']>;

/** The gateway's keys' specs: `relayTraffic` absent without stats to read. */
export interface GatewaySpecs {
  streams: StreamsSpec;
  metrics: MetricsSpec;
  relayTraffic: RelayTrafficSpec | undefined;
}

/** The connection details `connect` returns, whichever protocol. */
type Connection = Exclude<Awaited<ReturnType<Client['organisations']['streams']['exposures']['connect']['v1']>>, Error>;

/** Where `stats.connect` says to read a gateway's traffic stats. */
type StatsConnection = Exclude<
  Awaited<ReturnType<Client['organisations']['gateways']['stats']['connect']['v1']>>,
  Error
>;

/**
 * The credentials kept between asks, each until shortly before it expires: from `connect`, to publish each exposure,
 * by its ID; and from `stats.connect`, to read each gateway's stats, by the gateway's ID.
 */
export interface GatewayLeases {
  publish: Map<string, Connection>;
  stats: Map<string, StatsConnection>;
}

/**
 * The `streams`, `metrics` and `relayTraffic` specs of the `mediamtx` section: its paths as they are, each publisher
 * with where to publish from `connect`, the metrics of each path about what it delivers, and the relays' traffic of
 * each publisher's exposure, read from `stats.connect`.
 */
export async function gatewaySpecs(
  mediamtx: MediamtxSection,
  studio: Client,
  leases: GatewayLeases
): Promise<GatewaySpecs> {
  const publishers: MoqPublisher[] = [];
  for (const { exposureId, connect: ask, layout, renditions } of mediamtx.publishers) {
    // One whose credentials cannot be had is left out, and tried again next time.
    try {
      const connect = await publishTarget(studio, leases.publish, ask);
      publishers.push({ exposureId, ...connect, layout, renditions });
    } catch (error) {
      logger.error('Publisher {exposureId} is unavailable: {error}', { exposureId, error });
    }
  }
  const stats: RelayStatsSource[] = [];
  for (const ask of mediamtx.stats) {
    // A gateway whose stats cannot be read is left out, and tried again next time: publishing goes on regardless.
    try {
      stats.push({ connect: await statsTarget(studio, leases.stats, ask) });
    } catch (error) {
      logger.error('The stats of gateway {gatewayId} are unavailable: {error}', { gatewayId: ask.gatewayId, error });
    }
  }
  const { gatewayId, auth, tls, paths } = mediamtx;
  const previews = mediamtx.previews ?? [];
  const streams: StreamsSpec = { gatewayId, paths, previews, auth, tls, publishers };
  const attributions = paths.map(({ name, exposureId, rendition }) => ({ name, exposureId, rendition }));
  const metrics: MetricsSpec = { intervalMs: REPORT_INTERVAL_MS, paths: attributions };
  const relayTraffic = relayTrafficSpec(stats, publishers);
  return { streams, metrics, relayTraffic };
}

/**
 * The `relayTraffic` key's spec: the relays' stats to read, and each publisher's exposure by the path its broadcasts
 * are beneath on the relay. Absent without stats to read. With stats but no publishers, as when none's credentials
 * could be had this time, the relays are still followed: finalising would drop what is pending and the counters the
 * next rates are measured from, for publishers that are back with the next ask.
 */
function relayTrafficSpec(sources: RelayStatsSource[], publishers: MoqPublisher[]): RelayTrafficSpec | undefined {
  if (sources.length === 0) return undefined;
  const exposures = publishers.map(({ exposureId, connect }) => ({ exposureId, prefix: `${pathOf(connect)}/` }));
  return { sources, exposures };
}

/** The path a URL is dialed at, without its slashes: where a publisher's broadcasts are on the relay. */
function pathOf(url: string): string {
  const { pathname } = new URL(url);
  return pathname.replace(/^\/+/, '').replace(/\/+$/, '');
}

/** The `connect` ask the configuration gives for where to publish an exposure. */
type PublisherConnect = MediamtxSection['publishers'][number]['connect'];

/**
 * Where to publish the exposure: the relay URL to dial at its path, carrying its token as `?jwt=`, which the relay
 * reads, and the broadcast under it, from the lease `connect` gives (studio.ts); throws if it refuses, or the exposure
 * is not published by MoQ.
 */
async function publishTarget(studio: Client, connections: GatewayLeases['publish'], ask: PublisherConnect) {
  const renew = () => studio.organisations.streams.exposures.connect.v1(ask);
  const connection = await leased(connections, ask.exposureId, renew);
  if (!('relay' in connection)) throw new Error(`Exposure ${ask.exposureId} is not published by MoQ`);
  const url = new URL(connection.path, connection.relay);
  return { connect: withToken(url, connection.token), broadcast: connection.broadcast };
}

/** The `stats.connect` ask the configuration gives for where to read a gateway's traffic stats. */
type StatsConnect = MediamtxSection['stats'][number];

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
