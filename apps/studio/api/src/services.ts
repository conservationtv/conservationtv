import { AsyncLocalStorage } from 'node:async_hooks';
import type { Principal, Session } from '@conservationtv/umbrella';
import { z } from 'zod';
import type { Auth } from './auth/auth.ts';
import type { Database } from './db/client.ts';

/** The deployment's settings, validated from its bindings on first use. */
export const ConfigSchema = z.object({
  appUrl: z.url(),
  /** The first is the studio web app, which hosts the device-flow approval page. */
  webOrigins: z.array(z.url()).nonempty(),
  /** Only logging exists; see src/auth/otp.ts. */
  otpDelivery: z.literal('log'),
  authSecret: z.string().min(32)
});
export type Config = z.output<typeof ConfigSchema>;

/** Milliseconds since the epoch. Injected so time-dependent decisions can be exercised deterministically. */
export type Clock = () => number;

/** Keeps work alive after the response is sent; the Worker's `ctx.waitUntil`. */
export type Background = (task: Promise<unknown>) => void;

/**
 * Everything request handling depends on. The worker entrypoint builds one per request. Code reads the active set
 * through `services()` rather than threading it through every call. Connections and the clients built on them open
 * on first use, so requests that never touch storage never open a connection.
 */
export interface Services {
  config: Config;
  clock: Clock;
  background: Background;
  /** The owning role's connection. Request handlers use `secured()` instead. */
  admin(): Promise<Database>;
  /** The application role's connection, enforced by row-level security. */
  app(): Promise<Database>;
  /** The principal's request session over the application connection: every protected query runs inside it. */
  session(principal: Principal): Promise<Session>;
  auth(): Promise<Auth>;
}

const storage = new AsyncLocalStorage<Services>();

export function runWithServices<Result>(active: Services, task: () => Result): Result {
  return storage.run(active, task);
}

export function services(): Services {
  const active = storage.getStore();
  if (!active) throw new Error('services() called outside runWithServices()');
  return active;
}
