import { Client } from '@conservationtv/studio-sdk';

import { API_URL } from './auth-client';

/**
 * The generated studio SDK, sending the session cookie. Versioned operations need the handshake, which the root
 * route's middleware starts and each versioned call waits for; see apiHandshakeQueryOptions.
 */
export const api = new Client({
  baseUrl: API_URL,
  fetch: (input, init) => fetch(input, { ...init, credentials: 'include' })
});
