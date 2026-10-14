import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { passkey } from '@better-auth/passkey';
import { user as principalOf } from '@conservationtv/umbrella';
import { betterAuth } from 'better-auth';
import { bearer, deviceAuthorization, emailOTP } from 'better-auth/plugins';
import type { Access } from '@conservationtv/umbrella';
import type { Database } from '../db/client.ts';
import { self } from '../db/roles.ts';
import { account, deviceCodes, passkeys, session, users, verification } from '../db/schema.ts';
import type { Background, Config } from '../services.ts';
import type { OtpDelivery } from './otp.ts';

/** The device-flow clients this API issues sessions to. */
const DEVICE_CLIENTS = new Set(['studio-cli']);

export interface AuthDependencies {
  /** The admin connection: Better Auth owns its tables. */
  database: Database;
  /** The management API over the same owning connection, for provisioning grants. */
  access: Access;
  config: Config;
  deliverOtp: OtpDelivery;
  background: Background;
}

/**
 * Better Auth, mounted under `/auth`. Sign-up and sign-in are by emailed one-time code; an account can then register a
 * passkey (which needs a session) and sign in with it afterwards. There are no passwords and no organisations.
 *
 * The CLI signs in with the OAuth device flow: it shows a code, the person approves it in the web app at
 * `/device`, and the token it receives is sent as a bearer token on every request.
 */
export function createAuth({ database, access, config, deliverOtp, background }: AuthDependencies) {
  const appUrl = new URL(config.appUrl);
  const ensureSelfGrant = async (userId: string): Promise<void> => {
    await access.at(users.$access.scope.at(userId)).grant({ principal: principalOf(userId), role: self });
  };
  return betterAuth({
    baseURL: config.appUrl,
    basePath: '/auth',
    secret: config.authSecret,
    trustedOrigins: config.webOrigins,
    database: drizzleAdapter(database, {
      provider: 'pg',
      schema: { user: users, session, account, verification, passkey: passkeys, deviceCode: deviceCodes }
    }),
    emailAndPassword: { enabled: false },
    telemetry: { enabled: false },
    // Work Better Auth defers past the response (sending codes, cleanup) must outlive the request on Workers.
    advanced: { backgroundTasks: { handler: background } },
    databaseHooks: {
      // Provisioning: the account owns itself, which reaches every table bound to the user scope. The grant is an
      // idempotent upsert, so it is also ensured at every sign-in: an account whose creation hook failed heals itself.
      user: { create: { after: created => ensureSelfGrant(created.id) } },
      session: { create: { after: session => ensureSelfGrant(session.userId) } }
    },
    plugins: [
      emailOTP({ sendVerificationOTP: deliverOtp, disableSignUp: false }),
      passkey({
        rpID: appUrl.hostname,
        rpName: 'conservation.tv studio',
        origin: [config.appUrl, ...config.webOrigins],
        // Discoverable credentials carry their account, so the web app can sign in with a passkey without asking for
        // (or storing) an email first.
        authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' }
      }),
      deviceAuthorization({
        verificationUri: `${config.webOrigins[0]}/device`,
        validateClient: clientId => DEVICE_CLIENTS.has(clientId)
      }),
      bearer()
    ]
  });
}

export type Auth = ReturnType<typeof createAuth>;
