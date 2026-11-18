import { setTimeout as sleep } from 'node:timers/promises';
import type { Client } from '@conservationtv/studio-sdk';
import { getLogger } from '@logtape/logtape';
import { gatewaySpecs, type GatewayLeases, type GatewaySpecs } from '../gateway/index.ts';
import { outputSpecs, type OutputLeases, type OutputSpecs } from '../output/index.ts';
import { type DeviceConfiguration, useStudio } from '../studio.ts';

// How a conservation.tv agent learns what to run. Every `INTERVAL_MS` it:
//
//   1. asks the studio API for its configuration (`deviceConfiguration.get`, signed as the agent's device): a section
//      for each part of the agent it is to run, and none for those it isn't;
//   2. has each part turn its section into its keys' specs: the `mediamtx` section into the gateway's `streams`,
//      `metrics` and `relayTraffic` (gateway/configuration.ts), and the `obs` and `show` sections into the output's
//      `obs`, `channels` and `show` (output/configuration.ts);
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
export type StudioSpecs = Partial<GatewaySpecs & OutputSpecs>;

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

/** One answer from the studio API, signed as the agent's device. */
async function askConfiguration(studio: Client) {
  await studio.handshake();
  const configuration = await studio.deviceConfiguration.get.v1();
  if (configuration instanceof Error) throw configuration;
  return configuration;
}

/** The spec of each key the configuration has a section for. */
async function studioSpecs(configuration: DeviceConfiguration, studio: Client, leases: Leases): Promise<StudioSpecs> {
  let specs: StudioSpecs = {};
  if (configuration.mediamtx !== undefined) {
    const gateway = await gatewaySpecs(configuration.mediamtx, studio, leases.gateway);
    specs = { ...specs, ...gateway };
  }
  if (configuration.obs !== undefined) {
    const output = await outputSpecs(configuration.obs, configuration.show, studio, leases.output);
    specs = { ...specs, ...output };
  }
  return specs;
}
