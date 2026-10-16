import { arkenv } from '@arkenv/standard';
import { z } from 'zod';

/**
 * The deployment's settings, from its text bindings and secrets: under `nodejs_compat` they are also `process.env`,
 * which ArkEnv reads. The entrypoint loads them on first use, once per isolate; an invalid deployment fails every
 * request rather than running with a partial configuration.
 */
export const loadConfig = () =>
  arkenv({
    /** Where the API is served: Better Auth's base URL and the passkey relying party. */
    APP_URL: z.url(),
    /** Comma-separated. The first is the studio web app, which hosts the device-flow approval page. */
    WEB_ORIGINS: z.array(z.url()).nonempty(),
    /** Only logging exists; see src/auth/otp.ts. */
    OTP_DELIVERY: z.literal('log'),
    BETTER_AUTH_SECRET: z.string().min(32),
    /** The base64 32-byte master key for encrypted columns and blind indexes; see src/db/encrypted.ts. */
    FIELD_KEY: z.string().regex(/^[A-Za-z0-9+/]{43}=$/)
  });

export type Config = ReturnType<typeof loadConfig>;
