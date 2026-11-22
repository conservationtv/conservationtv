import { setTimeout as sleep } from 'node:timers/promises';
import { cameraOrigin } from '@conservationtv/cameras';
import type { Client } from '@conservationtv/studio-sdk';
import { getLogger } from '@logtape/logtape';
import { gatewaySpecs, type GatewayLeases, type GatewaySpecs } from '../gateway/index.ts';
import type { CamerasSpec, ProbesSpec } from '../cameras/index.ts';
import type { PeersSpec } from '../iroh/peers.ts';
import { outputSpecs, type ChatSpec, type OutputLeases, type OutputSpecs } from '../output/index.ts';
import { REPORT_INTERVAL_MS } from '../reporting/sampler.ts';
import { type ControllingConfiguration, type DeviceConfiguration, useStudio } from '../studio.ts';

// How a conservation.tv agent learns what to run. Every `INTERVAL_MS` it:
//
//   1. asks the studio API for its configuration (`deviceConfiguration.get`, signed as the agent's device): a section
//      for each part of the agent it is to run, and none for those it isn't;
//   2. has each part turn its section into its keys' specs: the `mediamtx` section into the gateway's `streams`,
//      `metrics` and `relayTraffic` (gateway/configuration.ts), and its cameras into `probes`; the `obs` and `show`
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
export type StudioSpecs = Partial<GatewaySpecs & OutputSpecs & ReachSpecs>;

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
    gateway: { publish: new Map(), stats: new Map() },
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
 * One answer from the studio API, signed as the agent's device: at version 3, which gives the agent its cameras and who
 * signs each preview's tokens, where the API serves it; otherwise at version 2, which says what to probe by URL, each
 * preview signed by no one, so its token is kept until it expires; and otherwise at version 1, as an API from before
 * cameras were probed gives it, with nothing to probe.
 */
async function askConfiguration(studio: Client): Promise<DeviceConfiguration> {
  await studio.handshake();
  if (studio.deviceConfiguration.get.version === 3) {
    const configuration = await studio.deviceConfiguration.get.v3();
    if (configuration instanceof Error) throw configuration;
    return withCameraUrls(configuration);
  }
  if (studio.deviceConfiguration.get.version === 2) {
    const configuration = await studio.deviceConfiguration.get.v2();
    if (configuration instanceof Error) throw configuration;
    return { ...configuration, obs: configuration.obs && unsigned(configuration.obs) };
  }
  const configuration = await studio.deviceConfiguration.get.v1();
  if (configuration instanceof Error) throw configuration;
  const { mediamtx, obs } = configuration;
  return { ...configuration, mediamtx: mediamtx && { ...mediamtx, probes: [] }, obs: obs && unsigned(obs) };
}

/** The `obs` section as versions 1 and 2 give it, before previews said who signs their tokens. */
type UnsignedObsSection = NonNullable<
  Exclude<Awaited<ReturnType<Client['deviceConfiguration']['get']['v2']>>, Error>['obs']
>;

/** An `obs` section from before previews said who signs their tokens: each signed by no one. */
function unsigned(obs: UnsignedObsSection): NonNullable<DeviceConfiguration['obs']> {
  return { ...obs, previews: obs.previews.map(preview => ({ ...preview, signer: null })) };
}

/** A path and a probe as the gateway and the probes work from them: with the URL to pull. */
type PulledPath = NonNullable<DeviceConfiguration['mediamtx']>['paths'][number];
type UrlProbe = NonNullable<DeviceConfiguration['mediamtx']>['probes'][number];

/**
 * The configuration with each camera its paths are pulled from, and its probes ask, as the URL the camera's driver
 * gives (`@conservationtv/cameras`), credentials included, which is what the gateway and the probes work from. A path
 * or probe naming a camera the configuration doesn't have, or a rendition the camera can't produce, is left out.
 */
function withCameraUrls(configuration: ControllingConfiguration): DeviceConfiguration {
  const { mediamtx, ...rest } = configuration;
  if (mediamtx === undefined) return rest;
  const cameras = new Map((configuration.cameras?.cameras ?? []).map(camera => [camera.id, camera]));
  const origin = (cameraId: string, rendition: Parameters<typeof cameraOrigin>[2]) => {
    const camera = cameras.get(cameraId);
    return camera === undefined ? undefined : cameraOrigin(camera.settings, camera.credentials, rendition);
  };
  const paths: PulledPath[] = [];
  for (const { source, ...path } of mediamtx.paths) {
    const url = 'cameraId' in source ? origin(source.cameraId, path.rendition) : undefined;
    if ('path' in source) paths.push({ ...path, source });
    else if (url !== undefined) paths.push({ ...path, source: { url } });
  }
  const probes: UrlProbe[] = [];
  for (const { subjectId, cameraId } of mediamtx.probes) {
    const url = origin(cameraId, 'default');
    if (url !== undefined) probes.push({ subjectId, url });
  }
  return { ...rest, mediamtx: { ...mediamtx, paths, probes } };
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
  }
  if (configuration.obs !== undefined) {
    const output = await outputSpecs(configuration.obs, configuration.show, studio, leases.output);
    specs = { ...specs, ...output };
  }
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
