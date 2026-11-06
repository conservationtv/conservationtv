import { queryOptions } from '@tanstack/react-query';

import { api } from '@/lib/api';

/** The organisations the signed-in account belongs to, oldest first. */
export const organisationListQueryOptions = () =>
  queryOptions({
    queryKey: ['organisations', 'list'] as const,
    queryFn: async () => {
      const result = await api.organisations.list.v1();
      if (result instanceof Error) throw result;
      return result.organisations;
    }
  });

/** One organisation the signed-in account belongs to. */
export const organisationQueryOptions = (organisationId: string) =>
  queryOptions({
    queryKey: ['organisations', organisationId, 'detail'] as const,
    queryFn: async () => {
      const result = await api.organisations.get.v1({ id: organisationId });
      if (result instanceof Error) throw result;
      return result;
    }
  });
