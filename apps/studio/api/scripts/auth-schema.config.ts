// Only for `pnpm auth:generate`: Better Auth's CLI reads an auth instance's plugins to write src/db/auth-schema.ts.
// The Worker builds its real instance per request in src/auth/auth.ts.
import { betterAuth } from 'better-auth';
import { bearer, deviceAuthorization, emailOTP } from 'better-auth/plugins';
import { passkey } from '@better-auth/passkey';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { drizzle } from 'drizzle-orm/node-postgres';
import { LOCAL_ADMIN_DATABASE_URL } from '../src/db/local.ts';

export const auth = betterAuth({
  database: drizzleAdapter(drizzle(LOCAL_ADMIN_DATABASE_URL), { provider: 'pg' }),
  emailAndPassword: { enabled: false },
  plugins: [emailOTP({ async sendVerificationOTP() {} }), passkey(), deviceAuthorization(), bearer()]
});
