import { Client } from '@conservationtv/studio-sdk';
import { createAuthClient } from 'better-auth/client';
import { deviceAuthorizationClient } from 'better-auth/client/plugins';

/** The studio API this CLI signs in to and calls. */
export const apiUrl = process.env.STUDIO_API_URL ?? 'http://localhost:5175';

/** Better Auth's routes on the API, as the web app reaches them. */
export function authClient() {
  return createAuthClient({ baseURL: `${apiUrl}/auth`, plugins: [deviceAuthorizationClient()] });
}

/** A studio client sending `token`, without a handshake: the generated commands make their own. */
export function studioClient(token: string | undefined) {
  const headers = token ? { authorization: `Bearer ${token}` } : undefined;
  return new Client({ baseUrl: apiUrl, headers });
}
