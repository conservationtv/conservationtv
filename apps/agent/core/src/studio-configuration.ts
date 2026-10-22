import { setTimeout as sleep } from 'node:timers/promises';
import type { Client } from '@conservationtv/studio-sdk';
import { getLogger } from '@logtape/logtape';
import { MEDIAMTX_MANIFEST, MOQ_MANIFEST, type MediamtxSpec, type MoqPublisher } from './runtimes/mediamtx/index.ts';
import { useStudio } from './studio.ts';

// How a conservation.tv agent learns what to run. Every `INTERVAL_MS` it:
//
//   1. asks the studio API for its configuration (`deviceConfiguration.get`, signed as the agent's device);
//   2. turns that into the spec for its MediaMTX: the paths it names, as they are, and each publisher it names, with
//      where to publish from `organisations.streams.exposures.connect`; and
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

const logger = getLogger(['agent', 'studio']);

/** What converge is told: the `mediamtx` key's spec, or that the key is absent. */
export type ApplyMediamtx = (spec: MediamtxSpec | undefined) => Promise<void>;

/**
 * Ask for the configuration now and every `INTERVAL_MS` until `signal` aborts, applying each answer. A failed ask
 * keeps the spec as it was, and is tried again next time. Resolves once stopped.
 */
export async function watchStudioConfiguration(signal: AbortSignal, apply: ApplyMediamtx): Promise<void> {
  const studio = useStudio();
  const connections: Connections = new Map();
  const logDiagnostics = diagnosticsLogger();
  while (!signal.aborted) {
    try {
      const configuration = await askConfiguration(studio);
      logDiagnostics(configuration);
      await apply(await mediamtxSpec(configuration, studio, connections));
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

/** Logs what the topology asks for that the configuration leaves out, whenever that changes. */
function diagnosticsLogger() {
  let logged = '';
  return (configuration: DeviceConfiguration) => {
    if (configuration.state === 'idle') return;
    const diagnostics = JSON.stringify(configuration.diagnostics);
    if (diagnostics === logged) return;
    logged = diagnostics;
    logger.info('The configuration has diagnostics', { diagnostics: configuration.diagnostics });
  };
}

/**
 * The MediaMTX spec the configuration asks for, or none when the agent is idle: its paths as they are, and each
 * publisher with where to publish from `connect`.
 */
async function mediamtxSpec(configuration: DeviceConfiguration, studio: Client, connections: Connections) {
  if (configuration.state === 'idle') return undefined;
  const publishers: MoqPublisher[] = [];
  for (const { exposureId, connect: ask, layout, renditions } of configuration.publishers) {
    // One whose credentials cannot be had is left out, and tried again next time.
    try {
      const connect = await publishTarget(studio, connections, ask);
      publishers.push({ exposureId, ...connect, layout, renditions });
    } catch (error) {
      logger.error('Publisher {exposureId} is unavailable: {error}', { exposureId, error });
    }
  }
  const spec: MediamtxSpec = {
    binary: MEDIAMTX_MANIFEST,
    paths: configuration.paths,
    auth: configuration.mediamtx.auth,
    publishers,
    moq: MOQ_MANIFEST,
    metricsIntervalMs: METRICS_INTERVAL_MS
  };
  return spec;
}

/** The configuration `deviceConfiguration.get` returns. */
type DeviceConfiguration = Exclude<Awaited<ReturnType<Client['deviceConfiguration']['get']['v1']>>, Error>;

/** The connection details `connect` returns, whichever protocol. */
type Connection = Exclude<Awaited<ReturnType<Client['organisations']['streams']['exposures']['connect']['v1']>>, Error>;

/** Connections from `connect` to publish each exposure by MoQ, by its ID, kept until shortly before they expire. */
type Connections = Map<string, Connection>;

/** The configuration of an agent that runs nothing. */
interface IdleConfiguration {
  state: 'idle';
}

/** The `connect` ask the configuration gives for where to publish an exposure. */
type PublisherConnect = Exclude<DeviceConfiguration, IdleConfiguration>['publishers'][number]['connect'];

/**
 * Where to publish the exposure: the relay URL to dial at its path, carrying its token as `?jwt=`, which the relay
 * reads, and the broadcast under it. Asks `connect` again when what is kept expires within `RENEW_BEFORE_MS`; throws
 * if it refuses, or the exposure is not published by MoQ.
 */
async function publishTarget(studio: Client, connections: Connections, ask: PublisherConnect) {
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
