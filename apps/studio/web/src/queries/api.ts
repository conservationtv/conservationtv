import { queryOptions } from '@tanstack/react-query';

import { api } from '@/lib/api';

/**
 * The SDK's handshake: the operation versions the server serves, which versioned calls need. Read once per page load
 * (the root route's middleware starts it, and versioned calls wait on it); a failure isn't cached, so the next
 * navigation tries again.
 */
export const apiHandshakeQueryOptions = () =>
  queryOptions({
    queryKey: ['api', 'handshake'] as const,
    queryFn: async () => {
      await api.handshake();
      return true;
    },
    staleTime: Infinity
  });
