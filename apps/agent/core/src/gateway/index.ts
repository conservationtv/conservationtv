import { join } from 'node:path';
import { controller } from '@conservationtv/converge';
import type { Client, DeviceIdentity } from '@conservationtv/studio-sdk';
import type { MediamtxApi } from '@conservationtv/mediamtx/api';
import { MEDIAMTX_MANIFEST } from '../binaries/mediamtx.ts';
import { MOQ_MANIFEST } from '../binaries/moq.ts';
import type { AgentConfiguration, MediamtxSettings } from '../config.ts';
import { MediamtxMetricsRuntime, MetricsSpecSchema } from './metrics/runtime.ts';
import { RelayTrafficRuntime, RelayTrafficSpecSchema } from './relay-traffic/runtime.ts';
import { EndpointRegistration } from './streams/endpoints.ts';
import { GatewayListening } from './streams/listening.ts';
import { DEFAULT_MEDIAMTX_PORTS, type MediamtxPortPins } from './streams/ports.ts';
import { MediamtxRuntime, StreamsSpecSchema } from './streams/runtime.ts';

// The gateway: a MediaMTX of the agent's own serving the organisation's cameras on its network, and publishing their
// exposures to MoQ relays. Its keys, from the configuration's `mediamtx` section, and `relays` for the last
// (configuration.ts):
//
//   streams       MediaMTX itself, who it admits, what it publishes, and where readers reach it (streams/);
//   metrics       what its metrics page says of each path (metrics/);
//   relayTraffic  what the relays carry of the exposures it covers, as they count it, and whether they have those it
//                 covers but does not publish (relay-traffic/). An agent running no MediaMTX may still have it.
//
// In streams/: paths.ts says which paths it serves and the exposure each delivers, ports.ts where it listens, chosen
// before each start (chosen.ts) and read by everything that reaches it (listening.ts), reach.ts how it and the agent
// reach each other, config.ts and builders/ what it serves, auth.ts who it admits, relay-check.ts
// whether the relay has what its publishers publish, tls.ts the certificate it serves with, endpoints.ts where readers
// reach it, as registered with the studio API, and control.ts how to tell it is up and which version it is; runtime.ts
// puts them together with converge's AttachedProcess. The releases it runs are in binaries/.

export { gatewaySpecs, relayTrafficSpec, type GatewayLeases, type GatewaySpecs } from './configuration.ts';
export { withMediamtxClient } from './streams/control.ts';
export { MediamtxPathsSchema, type MediamtxPath, type MediamtxPaths } from './streams/paths.ts';
export {
  MediamtxPortPinsSchema,
  MediamtxPortsSchema,
  type MediamtxPortPins,
  type MediamtxPorts
} from './streams/ports.ts';

/**
 * What the gateway is decided on once, when the agent starts: the ports pinned for MediaMTX, where it listens (chosen
 * before each start of it), its control API, which follows, and the registration of its endpoints with the studio API,
 * which the agent closes on stopping.
 */
export interface GatewaySetup {
  pins: MediamtxPortPins;
  listening: GatewayListening;
  mediamtx: MediamtxApi;
  registration: EndpointRegistration;
}

/** MediaMTX as the agent's own child, on the ports pinned and others it chooses, reached on loopback. */
export function gatewaySetup(settings: MediamtxSettings | undefined, studio: Client): GatewaySetup {
  const pins = settings?.ports ?? {};
  const listening = new GatewayListening({ ...DEFAULT_MEDIAMTX_PORTS, ...pins });
  const registration = new EndpointRegistration(studio);
  return { pins, listening, mediamtx: listening.api, registration };
}

/** The gateway's runtimes, by the key of the spec each converges to. */
export function gatewayControllers(config: AgentConfiguration, identity: DeviceIdentity, setup: GatewaySetup) {
  const { pins, listening, registration } = setup;
  const streams = new MediamtxRuntime({
    directory: join(config.directory, 'mediamtx'),
    binary: MEDIAMTX_MANIFEST,
    moq: MOQ_MANIFEST,
    identity,
    pins,
    listening,
    registration,
    node: config.node ?? { path: process.execPath }
  });
  const metrics = new MediamtxMetricsRuntime(config, () => listening.reach.metrics);
  const relayTraffic = new RelayTrafficRuntime();
  return {
    streams: controller({
      spec: StreamsSpecSchema,
      status: streams.status$,
      execute: (spec, signal) => streams.execute(spec, signal),
      finalize: () => streams.finalize(),
      dispose: () => streams.dispose()
    }),
    metrics: controller({
      spec: MetricsSpecSchema,
      status: metrics.status$,
      execute: spec => metrics.apply(spec),
      finalize: () => metrics.teardown(),
      dispose: () => metrics.dispose()
    }),
    relayTraffic: controller({
      spec: RelayTrafficSpecSchema,
      status: relayTraffic.status$,
      execute: spec => relayTraffic.apply(spec),
      finalize: () => relayTraffic.teardown(),
      dispose: () => relayTraffic.dispose()
    })
  };
}
