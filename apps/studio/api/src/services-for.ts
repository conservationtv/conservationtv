import { authorization } from './access.ts';
import { createAuth, type Auth } from './auth/auth.ts';
import { otpDelivery } from './auth/otp.ts';
import type { Config } from './config.ts';
import { connectLazily } from './db/client.ts';
import type { Background, Services } from './services.ts';

// Building a request's services loads the database schema, Better Auth and the authorization client. It is kept apart
// from src/services.ts, which only declares them, so that anything (encrypted columns included) can use the services
// store without importing the schema back.

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
