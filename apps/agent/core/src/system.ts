import { join } from 'node:path';
import { controller, converge } from '@conservationtv/converge';
import { createStore } from '@conservationtv/store';
import type { AgentConfiguration } from './config.ts';
import { StudioConnection } from './reporting.ts';
import { MachineRuntime, MachineSpecSchema } from './runtimes/machine.ts';
import { MEDIAMTX_MANIFEST } from './runtimes/mediamtx/binary.ts';
import { MediamtxRuntime, MediamtxSpecSchema } from './runtimes/mediamtx/runtime.ts';

function controllers(config: AgentConfiguration) {
  // One connection to the studio API for every runtime that reports; a direct agent has none.
  const studio = config.type === 'conservationtv' ? new StudioConnection(config) : undefined;
  const machine = new MachineRuntime(studio);
  const mediamtx = new MediamtxRuntime({ directory: join(config.directory, 'mediamtx'), studio });
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
      mediamtx: { mediamtx: MEDIAMTX_MANIFEST, metrics: { intervalMs: 60_000 } }
    })
  });
}

/** The running agent's system. The host supplies it with each request; handlers read it with `useSystem()`. */
export type AgentSystem = Awaited<ReturnType<typeof startSystem>>;
export const [withSystem, useSystem] = createStore<AgentSystem>('system');
