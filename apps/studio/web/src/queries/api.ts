import { queryOptions } from '@tanstack/react-query';

import { api } from '@/lib/api';

export const apiQueries = {
  all: () => ['api'] as const,
  /**
   * The SDK's handshake: the operation versions the server serves, which versioned calls need. Read once per page
   * load (the root route's middleware awaits it); a failure isn't cached, so the next navigation tries again.
   */
  handshake: () =>
    queryOptions({
      queryKey: [...apiQueries.all(), 'handshake'] as const,
      queryFn: async () => {
        await api.handshake();
        return true;
      },
      staleTime: Infinity
    })
};
