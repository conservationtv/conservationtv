import { join } from 'node:path';
import { controller, converge } from '@conservationtv/converge';
import { createStore } from '@conservationtv/store';
import type { AgentConfiguration } from './config.ts';
import { MachineRuntime, MachineSpecSchema, type MachineSpec } from './runtimes/machine.ts';
import {
  MEDIAMTX_MANIFEST,
  MediamtxRuntime,
  MediamtxSpecSchema,
  type MediamtxSpec
} from './runtimes/mediamtx/index.ts';
import { watchStudioConfiguration } from './studio-configuration.ts';

function controllers(config: AgentConfiguration) {
  const machine = new MachineRuntime(config);
  const mediamtx = new MediamtxRuntime(config, {
    directory: join(config.directory, 'mediamtx'),
    api: '127.0.0.1:9997',
    metrics: '127.0.0.1:9998',
    authHttp: '127.0.0.1:9996'
  });
  return {
    machine: controller({
      spec: MachineSpecSchema,
      status: machine.status$,
      execute: spec => machine.apply(spec),
      finalize: () => machine.teardown(),
      dispose: () => machine.dispose()
    }),
    mediamtx: controller({
      spec: MediamtxSpecSchema,
      status: mediamtx.status$,
      execute: (spec, signal) => mediamtx.execute(spec, signal),
      finalize: () => mediamtx.finalize(),
      dispose: () => mediamtx.dispose()
    })
  };
}

/** The spec the system starts from: its keys, each present or absent. */
interface RestoredSpec {
  machine: MachineSpec;
  mediamtx?: MediamtxSpec;
}

/** Every agent watches its machine; a direct agent also runs MediaMTX, serving any path. */
function restored(config: AgentConfiguration): RestoredSpec {
  const spec: RestoredSpec = { machine: { intervalMs: 60_000 } };
  if (config.type === 'direct') {
    spec.mediamtx = { binary: MEDIAMTX_MANIFEST, paths: [], publishers: [], metricsIntervalMs: 60_000 };
  }
  return spec;
}

/**
 * Start converging. A direct agent runs MediaMTX serving any path from the start. A conservation.tv agent runs it only
 * once its configuration (src/studio-configuration.ts) says it runs a MediaMTX gateway, serving exactly its paths.
 */
export function startSystem(config: AgentConfiguration) {
  return converge({
    controllers: controllers(config),
    restore: async () => restored(config),
    mutators:
      config.type === 'direct'
        ? []
        : [
            changes =>
              watchStudioConfiguration(config, spec =>
                spec === undefined ? changes.remove('mediamtx') : changes.set('mediamtx', spec)
              )
          ]
  });
}

/** The running agent's system. The host supplies it with each request; handlers read it with `useSystem()`. */
export type AgentSystem = Awaited<ReturnType<typeof startSystem>>;
export const [withSystem, useSystem] = createStore<AgentSystem>('system');
