import { queryOptions } from '@tanstack/react-query';

import { signalSystemOf } from '@/components/signal/signal-from-topology';
import { api } from '@/lib/api';

// An organisation's whole topology in one read (apps/studio/api/src/routes/topology.ts): its lists, its subjects'
// states, and what its broadcast places.

/**
 * The organisation's topology as the signal view draws it (`<Signal system>`). Refreshed while the page is open, as
 * the subjects' states are, since what is healthy changes without anything here changing it.
 */
export const signalSystemQueryOptions = (organisationId: string) =>
  queryOptions({
    queryKey: ['topology', organisationId, 'signal'] as const,
    queryFn: async () => {
      const result = await api.organisations.topology.get.v1({ id: organisationId });
      if (result instanceof Error) throw result;
      return signalSystemOf(result);
    },
    refetchInterval: 30_000
  });
