import { bearer, Client } from '@conservationtv/studio-sdk';
import { createAuthClient } from 'better-auth/client';
import { deviceAuthorizationClient } from 'better-auth/client/plugins';

/** What `ctv login --env` takes: the local dev server, or one of the studio's stacks (apps/studio/infrastructure). */
export const ENVIRONMENTS = ['local', 'preview', 'staging', 'prod'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/** Each environment's studio API: `pnpm dev`, or the stack's `apiDomain`. */
const API_URLS = {
  local: 'http://localhost:5175',
  preview: 'https://api.studio.preview.conservation.tv',
  staging: 'https://api.studio.staging.conservation.tv',
  prod: 'https://api.studio.conservation.tv'
} satisfies Record<Environment, string>;

/** The environment's studio API. */
export function apiUrlOf(env: Environment): string {
  return API_URLS[env];
}

/** Better Auth's routes on the API, as the web app reaches them. */
export function authClient(apiUrl: string) {
  return createAuthClient({ baseURL: `${apiUrl}/auth`, plugins: [deviceAuthorizationClient()] });
}

/** A studio client sending `token`, without a handshake: the generated commands make their own. */
export function studioClient(apiUrl: string, token: string | undefined) {
  const auth = token ? bearer(token) : undefined;
  return new Client({ baseUrl: apiUrl, auth });
}
