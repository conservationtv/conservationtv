import { Client } from '@conservationtv/studio-sdk';

import { API_URL } from './auth-client';

/**
 * The generated studio SDK, sending the session cookie. Versioned operations need the handshake, which the root
 * route's middleware completes before any loader runs; see apiQueries.handshake.
 */
export const api = new Client({
  baseUrl: API_URL,
  fetch: (input, init) => fetch(input, { ...init, credentials: 'include' })
});
