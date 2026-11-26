import { setTimeout as sleep } from 'node:timers/promises';
import { cameraOrigin } from '@conservationtv/cameras';
import type { Client } from '@conservationtv/studio-sdk';
import { getLogger } from '@logtape/logtape';
import { gatewaySpecs, relayTrafficSpec, type GatewayLeases, type GatewaySpecs } from '../gateway/index.ts';
import type { CamerasSpec, ProbesSpec } from '../cameras/index.ts';
import type { RelayTrafficSpec } from '../gateway/relay-traffic/runtime.ts';
import type { PeersSpec } from '../iroh/peers.ts';
import { outputSpecs, type ChatSpec, type OutputLeases, type OutputSpecs } from '../output/index.ts';
import { REPORT_INTERVAL_MS } from '../reporting/sampler.ts';
import {
  type DeliveringConfiguration,
  type DeviceConfiguration,
  type PulledPath,
  type RelaysSection,
  type UrlProbe,
  useStudio
} from '../studio.ts';

// How a conservation.tv agent learns what to run. Every `INTERVAL_MS` it:
//
//   1. asks the studio API for its configuration (`deviceConfiguration.get`, signed as the agent's device): a section
//      for each part of the agent it is to run, and none for those it isn't;
//   2. has each part turn its section into its keys' specs: the `mediamtx` section into the gateway's `streams` and
//      `metrics`, and the `relays` section, with the gateway's publishers, into `relayTraffic`
//      (gateway/configuration.ts), and its cameras into `probes`; the `obs` and `show`
//      sections into the output's `obs`, `channels` and `show` (output/configuration.ts); and the `cameras`, `chat`
//      and `peers` sections into the keys of the same names, as they are;
//   3. hands them to converge (system.ts), where each key changes what runs only when its spec changed, and is
//      finalised when its section is left out, or, for `relayTraffic` and `channels`, when it has nothing to read: no
//      relay's stats, or no channel with any.
//
// The credentials a section's specs carry are kept between asks until shortly before they expire (each part's
// leases), so the spec, and the processes run from it, stay the same between renewals.
//
// TODO: Be told of changes rather than polling, once the studio API can push them.

/** How often the agent asks for its configuration. */
const INTERVAL_MS = 30_000;

const logger = getLogger(['agent', 'studio']);

/** The specs the configuration gives each key: absent for a runtime it leaves out. */
export type StudioSpecs = Partial<GatewaySpecs & RelaySpecs & OutputSpecs & ReachSpecs>;

/** The spec of the key about what the relays carry of what the agent covers. */
interface RelaySpecs {
  relayTraffic: RelayTrafficSpec;
}

/** The specs of the keys about what the agent reaches, and who reaches it. */
interface ReachSpecs {
  probes: ProbesSpec;
  cameras: CamerasSpec;
  chat: ChatSpec;
  peers: PeersSpec;
}

/** What converge is told: each key's spec, or that it is absent. */
export type ApplyStudioSpecs = (specs: StudioSpecs) => Promise<void>;

/** The credentials kept between asks, by the part of the agent they are for. */
interface Leases {
  gateway: GatewayLeases;
  output: OutputLeases;
}

/**
 * Ask for the configuration now and every `INTERVAL_MS` until `signal` aborts, applying each answer. A failed ask
 * keeps the spec as it was, and is tried again next time. Resolves once stopped.
 */
export async function watchStudioConfiguration(signal: AbortSignal, apply: ApplyStudioSpecs): Promise<void> {
  const studio = useStudio();
  const leases: Leases = {
    gateway: { publish: new Map(), watch: new Map(), stats: new Map() },
    output: { previews: new Map() }
  };
  while (!signal.aborted) {
    try {
      const configuration = await askConfiguration(studio);
      await apply(await studioSpecs(configuration, studio, leases));
    } catch (error) {
      // Stopping aborts whatever ask is in flight: that is no failure.
      if (!signal.aborted) logger.error('Asking for the configuration failed: {error}', { error });
    }
    await sleep(INTERVAL_MS, undefined, { signal }).catch(() => undefined);
  }
}

/**
 * One answer from the studio API, signed as the agent's device: at version 4, which serves each exposure at one path,
 * where the API serves it; otherwise at version 3, which gives the agent its cameras and who signs each preview's
 * tokens; otherwise at version 2, which says what to probe by URL, each preview signed by no one, so its token is kept
 * until it expires; and otherwise at version 1, as an API from before cameras were probed gives it, with nothing to
 * probe. Before version 4 each path and publisher names its rendition (`onePathEach`).
 */
async function askConfiguration(studio: Client): Promise<DeviceConfiguration> {
  await studio.handshake();
  const { get } = studio.deviceConfiguration;
  if (get.version === 4) return withCameraUrls(answered(await get.v4()));
  if (get.version === 3) return fromVersion3(answered(await get.v3()));
  if (get.version === 2) return fromVersion2(answered(await get.v2()));
  return fromVersion1(answered(await get.v1()));
}

/** An answer, or the error it was, thrown. */
function answered<Answer>(answer: Answer | Error): Answer {
  if (answer instanceof Error) throw answer;
  return answer;
}

/** The configuration as version 3 gives it, as the agent works from it. */
function fromVersion3(configuration: VersionAnswer<'v3'>): DeviceConfiguration {
  const { mediamtx, ...rest } = configuration;
  if (mediamtx === undefined) return withCameraUrls(rest);
  const { stats, ...section } = onePathEach(mediamtx);
  return withCameraUrls({ ...rest, mediamtx: section, relays: publishedRelays(stats) });
}

/** The configuration as version 2 gives it, as the agent works from it. */
function fromVersion2({ mediamtx, obs, show }: VersionAnswer<'v2'>): DeviceConfiguration {
  if (mediamtx === undefined) return { obs: obs && unsigned(obs), show };
  const { stats, ...section } = onePathEach(mediamtx);
  return { mediamtx: section, relays: publishedRelays(stats), obs: obs && unsigned(obs), show };
}

/** The configuration as version 1 gives it, as the agent works from it: with nothing to probe. */
function fromVersion1({ mediamtx, obs, show }: VersionAnswer<'v1'>): DeviceConfiguration {
  if (mediamtx === undefined) return { obs: obs && unsigned(obs), show };
  const { stats, ...section } = onePathEach(mediamtx);
  return { mediamtx: { ...section, probes: [] }, relays: publishedRelays(stats), obs: obs && unsigned(obs), show };
}

/**
 * The `relays` section, from the stats a version before 4 names in its `mediamtx` section: those of the gateways the
 * agent publishes to, with nothing to watch, since those versions cover only what the agent publishes.
 */
function publishedRelays(stats: RelaysSection['stats']): RelaysSection | undefined {
  return stats.length === 0 ? undefined : { stats, watched: [] };
}

/** What a version of `deviceConfiguration.get` answers. */
type VersionAnswer<Version extends 'v1' | 'v2' | 'v3'> = Exclude<
  Awaited<ReturnType<Client['deviceConfiguration']['get'][Version]>>,
  Error
>;

/** The `obs` section as versions 1 and 2 give it, before previews said who signs their tokens. */
type UnsignedObsSection = NonNullable<
  Exclude<Awaited<ReturnType<Client['deviceConfiguration']['get']['v2']>>, Error>['obs']
>;

/** An `obs` section from before previews said who signs their tokens: each signed by no one. */
function unsigned(obs: UnsignedObsSection): NonNullable<DeviceConfiguration['obs']> {
  return { ...obs, previews: obs.previews.map(preview => ({ ...preview, signer: null })) };
}

/** What versions before 4 call the one rendition every path and publisher delivers. */
const ONLY_RENDITION = 'default';

/** A path as versions before 4 give it: naming the rendition of its exposure it delivers. */
interface RenditionPath {
  rendition: string;
}

/** A rendition a publisher publishes, as versions before 4 give it: read from a path. */
interface PublishedRendition {
  rendition: string;
  path: string;
}

/** A publisher as versions before 4 give it: each rendition it publishes. */
interface RenditionPublisher<Connect> {
  exposureId: string;
  connect: Connect;
  renditions: PublishedRendition[];
}

/** The `mediamtx` section as versions before 4 give it. */
interface RenditionSection<Path extends RenditionPath, Connect> {
  paths: Path[];
  publishers: RenditionPublisher<Connect>[];
}

/**
 * A `mediamtx` section from before version 4 as version 4 says it: each exposure's `default` path, and each publisher
 * reading that. An API from before the renditions went may name others, which nothing reads now: they are left out.
 */
function onePathEach<Path extends RenditionPath, Connect, Section extends object>(
  mediamtx: Section & RenditionSection<Path, Connect>
) {
  const { paths, publishers, ...rest } = mediamtx;
  const delivered = paths
    .filter(path => path.rendition === ONLY_RENDITION)
    .map(({ rendition: _rendition, ...path }) => path);
  const published = publishers.flatMap(({ exposureId, connect, renditions }) => {
    const read = renditions.find(({ rendition }) => rendition === ONLY_RENDITION);
    return read === undefined ? [] : [{ exposureId, connect, path: read.path }];
  });
  return { ...rest, paths: delivered, publishers: published };
}

/**
 * The configuration with each camera its paths are pulled from, and its probes ask, as the URL the camera's driver
 * gives (`@conservationtv/cameras`), credentials included, which is what the gateway and the probes work from. A path
 * or probe naming a camera the configuration doesn't have is left out. A pushed path has no source, and the digest of
 * the key an encoder may push to it with, if its stream has one.
 */
function withCameraUrls(configuration: DeliveringConfiguration): DeviceConfiguration {
  const { mediamtx, ...rest } = configuration;
  if (mediamtx === undefined) return rest;
  const cameras = new Map((configuration.cameras?.cameras ?? []).map(camera => [camera.id, camera]));
  const origin = (cameraId: string) => {
    const camera = cameras.get(cameraId);
    return camera === undefined ? undefined : cameraOrigin(camera.settings, camera.credentials);
  };
  const paths = mediamtx.paths.flatMap(path => pulledPath(path, origin));
  const probes: UrlProbe[] = [];
  for (const { subjectId, cameraId } of mediamtx.probes) {
    const url = origin(cameraId);
    if (url !== undefined) probes.push({ subjectId, url });
  }
  return { ...rest, mediamtx: { ...mediamtx, paths, probes } };
}

/** A path as version 4 gives it. */
type DeliveringPath = NonNullable<DeliveringConfiguration['mediamtx']>['paths'][number];

/**
 * A path as the gateway works from it: pulled from its camera's URL (none for a camera the configuration doesn't
 * have) or another of its paths; or pushed, with no source, and the digest of its stream's key if it has one.
 */
function pulledPath(
  { source, ...path }: DeliveringPath,
  origin: (cameraId: string) => string | undefined
): PulledPath[] {
  if ('push' in source) {
    const { keySha256 } = source.push;
    return [keySha256 === null ? path : { ...path, keySha256 }];
  }
  if ('path' in source) return [{ ...path, source }];
  const url = origin(source.cameraId);
  return url === undefined ? [] : [{ ...path, source: { url } }];
}

/** The spec of each key the configuration has a section for. */
async function studioSpecs(configuration: DeviceConfiguration, studio: Client, leases: Leases): Promise<StudioSpecs> {
  let specs: StudioSpecs = {};
  if (configuration.mediamtx !== undefined) {
    const gateway = await gatewaySpecs(configuration.mediamtx, studio, leases.gateway);
    specs = { ...specs, ...gateway };
    // With no camera to probe the key is left out, and its runtime finalised.
    const cameras = configuration.mediamtx.probes;
    if (cameras.length > 0) specs = { ...specs, probes: { intervalMs: REPORT_INTERVAL_MS, cameras } };
  } else leases.gateway.publish.clear();
  // What the relays carry of every exposure the agent covers: those its gateway publishes, and those it watches.
  const publishers = specs.streams?.publishers ?? [];
  const relayTraffic = await relayTrafficSpec(configuration.relays, publishers, studio, leases.gateway);
  if (relayTraffic !== undefined) specs = { ...specs, relayTraffic };
  if (configuration.obs !== undefined) {
    const output = await outputSpecs(configuration.obs, configuration.show, studio, leases.output);
    specs = { ...specs, ...output };
  } else leases.output.previews.clear();
  return { ...specs, ...reachSpecs(configuration) };
}

/**
 * The `cameras`, `chat` and `peers` specs, of the sections of the same names: each left out with its section, as all
 * are by a studio API from before version 3. Without `peers` the agent serves anyone, as it did then.
 */
function reachSpecs({ cameras, chat, peers }: DeviceConfiguration): Partial<ReachSpecs> {
  const specs: Partial<ReachSpecs> = {};
  if (cameras !== undefined) specs.cameras = { issuer: cameras.grants.issuer, cameras: cameras.cameras };
  if (chat !== undefined) specs.chat = chat;
  if (peers !== undefined) specs.peers = { peers };
  return specs;
}
