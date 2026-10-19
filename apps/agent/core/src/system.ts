import { join } from 'node:path';
import { controller, converge } from '@conservationtv/converge';
import { createStore } from '@conservationtv/store';
import type { AgentConfiguration } from './config.ts';
import { MachineRuntime, MachineSpecSchema } from './runtimes/machine.ts';
import { MEDIAMTX_MANIFEST, MediamtxRuntime, MediamtxSpecSchema } from './runtimes/mediamtx/index.ts';

function controllers(config: AgentConfiguration) {
  const machine = new MachineRuntime(config);
  const mediamtx = new MediamtxRuntime(config, {
    directory: join(config.directory, 'mediamtx'),
    api: '127.0.0.1:9997',
    metrics: '127.0.0.1:9998'
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

export function startSystem(config: AgentConfiguration) {
  return converge({
    controllers: controllers(config),
    restore: async () => ({
      machine: { intervalMs: 60_000 },
      mediamtx: { binary: MEDIAMTX_MANIFEST, paths: config.mediamtxPaths ?? [], metricsIntervalMs: 60_000 }
    })
  });
}

/** The running agent's system. The host supplies it with each request; handlers read it with `useSystem()`. */
export type AgentSystem = Awaited<ReturnType<typeof startSystem>>;
export const [withSystem, useSystem] = createStore<AgentSystem>('system');
