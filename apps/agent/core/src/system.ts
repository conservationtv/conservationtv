import { resolver, splat, staticMutator } from '@conservationtv/splat';
import { createStore } from '@conservationtv/store';
import { HeartbeatRuntime, HeartbeatSpecSchema } from './runtimes/heartbeat.ts';

// The demo's spec is fixed in code: nothing persists it, and nothing changes it while the agent runs.
const DESIRED = {
  heartbeat: { intervalMs: 5_000, message: 'The agent is alive' }
};

export function startSystem() {
  const heartbeat = new HeartbeatRuntime();
  return splat({
    resolvers: {
      heartbeat: resolver({
        spec: HeartbeatSpecSchema,
        status: heartbeat.status$,
        execute: spec => heartbeat.apply(spec),
        finalize: () => heartbeat.teardown(),
        dispose: () => heartbeat.dispose()
      })
    },
    mutators: [staticMutator(DESIRED)]
  });
}

/** The running agent's system. The host supplies it with each request; handlers read it with `useSystem()`. */
export type AgentSystem = Awaited<ReturnType<typeof startSystem>>;
export const [withSystem, useSystem] = createStore<AgentSystem>('system');
