import { join } from 'node:path';
import { controller } from '@conservationtv/converge';
import type { Client, DeviceIdentity } from '@conservationtv/studio-sdk';
import type { MediamtxApi } from '@conservationtv/mediamtx/api';
import { MEDIAMTX_MANIFEST } from '../binaries/mediamtx.ts';
import { MOQ_MANIFEST } from '../binaries/moq.ts';
import type { AgentConfiguration, MediamtxSettings } from '../config.ts';
import { MediamtxMetricsRuntime, MetricsSpecSchema } from './metrics/runtime.ts';
import { RelayTrafficRuntime, RelayTrafficSpecSchema } from './relay-traffic/runtime.ts';
import { createMediamtxClient } from './streams/control.ts';
import { EndpointRegistration } from './streams/endpoints.ts';
import { DEFAULT_MEDIAMTX_PORTS, type MediamtxPorts } from './streams/ports.ts';
import { localReach, type MediamtxReach } from './streams/reach.ts';
import { MediamtxRuntime, StreamsSpecSchema } from './streams/runtime.ts';

// The gateway: a MediaMTX of the agent's own serving the organisation's cameras on its network, and publishing their
// exposures to MoQ relays. Its keys, all from the configuration's `mediamtx` section (configuration.ts):
//
//   streams       MediaMTX itself, who it admits, what it publishes, and where readers reach it (streams/);
//   metrics       what its metrics page says of each path (metrics/);
//   relayTraffic  what the relays carry of the exposures it publishes, as they count it (relay-traffic/).
//
// In streams/: paths.ts says which paths it serves and the exposure each delivers, ports.ts where it listens, reach.ts
// how it and the agent reach each other, config.ts and builders/ what it serves, auth.ts who it admits, joiner.ts how
// its publishers' renditions become one broadcast, tls.ts the certificate it serves with, endpoints.ts where readers
// reach it, as registered with the studio API, and control.ts how to tell it is up and which version it is; runtime.ts
// puts them together with converge's AttachedProcess. The releases it runs are in binaries/.

export { gatewaySpecs, type GatewayLeases, type GatewaySpecs } from './configuration.ts';
export { withMediamtxClient } from './streams/control.ts';
export { MediamtxPathsSchema, type MediamtxPath, type MediamtxPaths } from './streams/paths.ts';
export { MediamtxPortsSchema, type MediamtxPorts } from './streams/ports.ts';

/**
 * What the gateway is decided on once, when the agent starts: where MediaMTX listens, how it and the agent reach each
 * other, its control API, and the registration of its endpoints with the studio API, which the agent closes on stopping.
 */
export interface GatewaySetup {
  ports: MediamtxPorts;
  reach: MediamtxReach;
  mediamtx: MediamtxApi;
  registration: EndpointRegistration;
}

/** MediaMTX as the agent's own child, on the configured ports or its own, reached on loopback. */
export function gatewaySetup(settings: MediamtxSettings | undefined, studio: Client): GatewaySetup {
  const ports = settings?.ports ?? DEFAULT_MEDIAMTX_PORTS;
  const reach = localReach(ports);
  const mediamtx = createMediamtxClient(reach.api);
  const registration = new EndpointRegistration(studio);
  return { ports, reach, mediamtx, registration };
}

/** The gateway's runtimes, by the key of the spec each converges to. */
export function gatewayControllers(config: AgentConfiguration, identity: DeviceIdentity, setup: GatewaySetup) {
  const { ports, reach, registration } = setup;
  const streams = new MediamtxRuntime({
    directory: join(config.directory, 'mediamtx'),
    binary: MEDIAMTX_MANIFEST,
    moq: MOQ_MANIFEST,
    identity,
    ports,
    reach,
    registration
  });
  const metrics = new MediamtxMetricsRuntime(config, reach.metrics);
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
