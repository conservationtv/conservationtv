import { createStore } from '@conservationtv/store';
import type { Principal, Session } from '@conservationtv/umbrella';
import { authorization } from './access.ts';
import { createAuth, type Auth } from './auth/auth.ts';
import { otpDelivery } from './auth/otp.ts';
import type { Config } from './config.ts';
import { connectLazily, type Database } from './db/client.ts';

/** Milliseconds since the epoch. Injected so time-dependent decisions can be exercised deterministically. */
export type Clock = () => number;

/** Keeps work alive after the response is sent; the Worker's `ctx.waitUntil`. */
export type Background = (task: Promise<unknown>) => void;

/**
 * Everything request handling depends on. The worker entrypoint builds one per request. Code reads the active set
 * through `useServices()` rather than threading it through every call. Connections and the clients built on them open
 * on first use, so requests that never touch storage never open a connection.
 */
export interface Services {
  config: Config;
  clock: Clock;
  background: Background;
  /** The owning role's connection. Request handlers use `session()` instead. */
  admin(): Promise<Database>;
  /** The application role's connection, enforced by row-level security. */
  app(): Promise<Database>;
  /** The principal's request session over the application connection: every protected query runs inside it. */
  session(principal: Principal): Promise<Session<Database>>;
  auth(): Promise<Auth>;
}

const ServicesStore = createStore<Services>('services');
export const [withServices, useServices] = ServicesStore;

/** Where the two Postgres roles connect: the Worker's Hyperdrive bindings. */
export interface ConnectionStrings {
  admin: string;
  app: string;
}

/** One request's services, and `close` to end its connections once the response is sent. */
export function servicesFor(config: Config, connections: ConnectionStrings, background: Background) {
  const admin = connectLazily(connections.admin);
  const application = connectLazily(connections.app);
  let auth: Promise<Auth> | undefined = undefined;
  const services: Services = {
    config,
    clock: Date.now,
    background,
    admin: admin.database,
    app: application.database,
    session: async principal => authorization.as(await application.database(), principal),
    // Better Auth owns its tables, so it is built over the admin connection, once per request.
    auth: () => {
      if (auth === undefined)
        auth = admin.database().then(database =>
          createAuth({
            database,
            access: authorization.access(database),
            config,
            deliverOtp: otpDelivery(config.OTP_DELIVERY),
            background
          })
        );
      return auth;
    }
  };
  return { services, close: () => Promise.all([admin.close(), application.close()]) };
}
