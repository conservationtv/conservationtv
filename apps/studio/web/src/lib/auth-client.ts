import { passkeyClient } from '@better-auth/passkey/client';
import { createAuthClient } from 'better-auth/client';
import { deviceAuthorizationClient, emailOTPClient } from 'better-auth/client/plugins';

import { config } from './config';

/** The studio API. Its cookies are same-site, so credentials travel with every call. */
export const API_URL = config.apiUrl;

/**
 * Better Auth's routes on the API. Calls resolve with their data and reject with a BetterFetchError, as TanStack
 * Query expects, rather than resolving `{ data, error }`.
 */
export const authClient = createAuthClient({
  baseURL: `${API_URL}/auth`,
  fetchOptions: { throw: true },
  plugins: [emailOTPClient(), passkeyClient(), deviceAuthorizationClient()]
});
