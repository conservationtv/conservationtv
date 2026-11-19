import { queryOptions } from '@tanstack/react-query';

import { api } from '@/lib/api';

// An organisation's whole topology in one read (apps/studio/api/src/routes/topology.ts): its lists, its subjects'
// states, and what each of its shows places. What reads it selects what it needs from it: the signal view's system
// (signalSystemOf), say.

/** The organisation's topology. Refreshed while the page is open, as what is healthy changes with nothing here changing it. */
export const topologyQueryOptions = (organisationId: string) =>
  queryOptions({
    queryKey: ['topology', organisationId] as const,
    queryFn: async () => {
      const result = await api.organisations.topology.get.v1({ id: organisationId });
      if (result instanceof Error) throw result;
      return result;
    },
    refetchInterval: 30_000
  });
