import { homedir } from 'node:os';
import { join } from 'node:path';
import { controller, converge, type SystemSpec } from '@conservationtv/converge';
import { createStore } from '@conservationtv/store';
import type { AgentConfiguration } from './config.ts';
import { MachineRuntime, MachineSpecSchema } from './runtimes/machine.ts';
import { DeviceIdentity } from '@conservationtv/studio-sdk';
import { MediamtxRuntime, MediamtxSpecSchema } from './runtimes/mediamtx.ts';
import { mediamtxRelease } from './runtimes/mediamtx-release.ts';

function controllers(config: AgentConfiguration, directory: string) {
  const machine = new MachineRuntime(config);
  const mediamtx = new MediamtxRuntime(config, join(directory, 'mediamtx'));
  return {
    mediamtx: controller({
      spec: MediamtxSpecSchema,
      status: mediamtx.status$,
      execute: (spec, signal) => mediamtx.execute(spec, signal),
      finalize: () => mediamtx.finalize(),
      dispose: () => mediamtx.dispose()
    }),
    machine: controller({
      spec: MachineSpecSchema,
      status: machine.status$,
      execute: spec => machine.apply(spec),
      finalize: () => machine.teardown(),
      dispose: () => machine.dispose()
    })
  };
}

export async function startSystem(config: AgentConfiguration) {
  const identity = await DeviceIdentity.fromSecretKey(config.secretKey);
  const directory = join(homedir(), '.conservationtv', 'agents', identity.publicId);
  const runtimes = controllers(config, directory);
  const spec: SystemSpec<typeof runtimes> = {
    mediamtx: { mediamtx: mediamtxRelease, intervalMs: 60_000 }
  };
  if (config.type === 'conservationtv') spec.machine = { intervalMs: 60_000 };
  return converge({ controllers: runtimes, restore: async () => spec });
}

/** The running agent's system. The host supplies it with each request; handlers read it with `useSystem()`. */
export type AgentSystem = Awaited<ReturnType<typeof startSystem>>;
export const [withSystem, useSystem] = createStore<AgentSystem>('system');
