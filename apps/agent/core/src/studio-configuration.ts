import { setTimeout as sleep } from 'node:timers/promises';
import {
  Client,
  DeviceIdentity,
  deviceSignature,
  type DeviceConfiguration,
  type ExposureConnectParams
} from '@conservationtv/studio-sdk';
import type { ConservationTvConfiguration } from './config.ts';
import {
  MEDIAMTX_MANIFEST,
  MOQ_MANIFEST,
  type MediamtxPath,
  type MediamtxSpec,
  type MoqPublisher
} from './runtimes/mediamtx/index.ts';

// How a conservation.tv agent learns what to run. Every `INTERVAL_MS` it:
//
//   1. asks the studio API for its configuration (`deviceConfiguration.get`, signed as the agent's device);
//   2. turns that into the spec for its MediaMTX: a path for each rendition it serves, pulled from the camera, and a
//      publisher for each exposure it publishes by MoQ, reading each rendition from the path it is served at; and
//   3. hands the spec to converge as the `mediamtx` key, which rewrites MediaMTX's config only when the spec changed.
//
// A publisher reads its renditions on this machine, which needs no token (runtimes/mediamtx/auth.ts), and publishes
// them to the relay with credentials from `organisations.streams.exposures.connect`. Those are kept until shortly
// before they expire, so the spec, and the processes run from it, stay the same between renewals.
//
// TODO: Be told of changes rather than polling, once the studio API can push them.

/** How often the agent asks for its configuration. */
const INTERVAL_MS = 30_000;

/** How often MediaMTX's metrics are shipped. */
const METRICS_INTERVAL_MS = 60_000;

/** How long before a credential expires it is renewed. Longer than `INTERVAL_MS`, so one ask always catches it. */
const RENEW_BEFORE_MS = 10 * 60_000;

type PlannedExposure = DeviceConfiguration['exposures'][string];

/** What converge is told: the `mediamtx` key's spec, or that the key is absent. */
export type ApplyMediamtx = (spec: MediamtxSpec | undefined) => Promise<void>;

/**
 * Ask for the configuration now and every `INTERVAL_MS` until stopped, applying each answer. A failed ask keeps the
 * spec as it was, and is tried again next time. Returns the cleanup that stops it.
 */
export function watchStudioConfiguration(config: ConservationTvConfiguration, apply: ApplyMediamtx): () => void {
  const stopped = new AbortController();
  const run = async () => {
    const identity = await DeviceIdentity.fromSecretKey(config.secretKey);
    const studio = new Client({ baseUrl: config.studioUrl, auth: deviceSignature(identity) });
    const credentials = new Credentials(studio);
    const logDiagnostics = diagnosticsLogger();
    while (!stopped.signal.aborted) {
      try {
        const configuration = await askConfiguration(studio);
        logDiagnostics(configuration);
        await apply(await mediamtxSpec(configuration, credentials));
      } catch (error) {
        // Stopping aborts whatever ask is in flight: that is no failure.
        if (!stopped.signal.aborted)
          console.error(JSON.stringify({ event: 'configuration_failed', error: String(error) }));
      }
      await sleep(INTERVAL_MS, undefined, { signal: stopped.signal }).catch(() => undefined);
    }
  };
  void run();
  return () => stopped.abort();
}

/** One answer from the studio API, signed as the agent's device. */
async function askConfiguration(studio: Client) {
  await studio.handshake();
  const configuration = await studio.deviceConfiguration.get.v1();
  if (configuration instanceof Error) throw configuration;
  return configuration;
}

/** Logs what the topology asks for that the configuration leaves out, whenever that changes. */
function diagnosticsLogger() {
  let logged = '';
  return (configuration: DeviceConfiguration) => {
    const diagnostics = JSON.stringify(configuration.diagnostics);
    if (diagnostics === logged) return;
    logged = diagnostics;
    console.log(JSON.stringify({ event: 'configuration_diagnostics', diagnostics: configuration.diagnostics }));
  };
}

/** The MediaMTX spec the configuration asks for, or none when the agent runs no MediaMTX gateway. */
async function mediamtxSpec(configuration: DeviceConfiguration, credentials: Credentials) {
  if (configuration.mediamtx === null) return undefined;
  const spec: MediamtxSpec = {
    binary: MEDIAMTX_MANIFEST,
    paths: servedPaths(configuration),
    auth: configuration.mediamtx.auth,
    publishers: await publishers(configuration, credentials),
    moq: MOQ_MANIFEST,
    metricsIntervalMs: METRICS_INTERVAL_MS
  };
  return spec;
}

/** A path for each rendition of each exposure the agent serves, pulled from its stream's origin. */
function servedPaths(configuration: DeviceConfiguration): MediamtxPath[] {
  return Object.entries(configuration.exposures).flatMap(([exposureId, exposure]) => {
    if (exposure.ingest !== 'pull') return [];
    const stream = configuration.streams[exposure.streamId];
    return exposure.renditions.flatMap(rendition => {
      const name = exposure.paths[rendition];
      const origin = stream?.renditions[rendition];
      if (name === undefined || origin === undefined) return [];
      return [{ name, exposureId, rendition, source: origin.url }];
    });
  });
}

/**
 * A publisher for each exposure the agent publishes by MoQ. One whose credentials cannot be had is left out, and
 * tried again next time.
 */
async function publishers(configuration: DeviceConfiguration, credentials: Credentials) {
  const found: MoqPublisher[] = [];
  for (const [exposureId, exposure] of Object.entries(configuration.exposures)) {
    if (exposure.ingest !== 'moq' || exposure.upstream === null) continue;
    try {
      found.push(await publisher(configuration, exposureId, exposure, credentials));
    } catch (error) {
      console.error(JSON.stringify({ event: 'publisher_unavailable', exposureId, error: String(error) }));
    }
  }
  return found;
}

/**
 * One exposure's publisher: each rendition read from the path its upstream is served at here, and published under the
 * exposure's path on the relay.
 */
async function publisher(
  configuration: DeviceConfiguration,
  exposureId: string,
  exposure: PlannedExposure,
  credentials: Credentials
): Promise<MoqPublisher> {
  const paths = configuration.exposures[exposure.upstream!.id]?.paths ?? {};
  const renditions = exposure.renditions.flatMap(rendition => {
    const source = paths[rendition];
    return source === undefined ? [] : [{ rendition, source }];
  });
  const publish = { action: 'publish', protocol: 'moq' } as const;
  const relay = await credentials.get(configuration.organisationId, exposure.streamId, exposureId, publish);
  if (!('relay' in relay)) throw new Error(`Exposure ${exposureId} is not published by MoQ`);
  const connect = withToken(new URL(relay.path, relay.relay).href, relay.token);
  return { exposureId, connect, broadcast: relay.broadcast, renditions };
}

/** A URL carrying its token as `?jwt=`, which the relay reads. */
function withToken(url: string, token: string | undefined) {
  const withQuery = new URL(url);
  if (token !== undefined) withQuery.searchParams.set('jwt', token);
  return withQuery.href;
}

/** The connection details `connect` returns, whichever protocol. */
type Connection = Exclude<Awaited<ReturnType<Client['organisations']['streams']['exposures']['connect']['v1']>>, Error>;

/** What to connect to an exposure for: an action, by a protocol. */
type ConnectionAsk = Omit<ExposureConnectParams, 'id' | 'streamId' | 'exposureId'>;

/** Connections from `connect`, kept until shortly before they expire. */
class Credentials {
  private readonly kept = new Map<string, Connection>();

  constructor(private readonly studio: Client) {}

  /** The connection, renewed if what is kept expires within `RENEW_BEFORE_MS`; throws if `connect` refuses. */
  async get(organisationId: string, streamId: string, exposureId: string, ask: ConnectionAsk) {
    const key = JSON.stringify([organisationId, exposureId, ask]);
    const kept = this.kept.get(key);
    if (kept !== undefined && !expiresSoon(kept)) return kept;
    const params = { id: organisationId, streamId, exposureId, ...ask };
    const connection = await this.studio.organisations.streams.exposures.connect.v1(params);
    if (connection instanceof Error) throw connection;
    this.kept.set(key, connection);
    return connection;
  }
}

function expiresSoon(connection: Connection) {
  if (connection.expiresAt === undefined) return false;
  return Date.parse(connection.expiresAt) - Date.now() < RENEW_BEFORE_MS;
}
