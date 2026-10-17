import { createStore } from '@conservationtv/store';
import type { services, Variables } from './config.ts';

/** Milliseconds since the epoch. Injected so time-dependent decisions can be exercised deterministically. */
export type Clock = () => number;

/** Keeps work alive after the response is sent; the Worker's `ctx.waitUntil`. */
export type Background = (task: Promise<unknown>) => void;

/** The clients `services` builds; `close` is the entrypoint's alone. */
type Clients = Omit<ReturnType<typeof services>, 'close'>;

/**
 * Everything request handling depends on: the deployment's variables and the clients built from them. The worker
 * entrypoint creates one per request (`createEnvironment` in src/env/config.ts). Code reads the active one through
 * `useEnvironment()` rather than threading it through every call.
 */
export interface Environment extends Clients {
  variables: Variables;
}

const EnvironmentStore = createStore<Environment>('environment');
export const [withEnvironment, useEnvironment] = EnvironmentStore;
