import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type { OrganisationCreateParams } from '@conservationtv/studio-sdk';

import { api } from '@/lib/api';

/** The organisations the signed-in account belongs to, oldest first, each with the roles it holds there. */
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

/** Start an organisation, administered by the signed-in account, which goes by `displayName` there. */
export function useCreateOrganisation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (organisation: OrganisationCreateParams) => {
      const result = await api.organisations.create.v1(organisation);
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['organisations', 'list'] })
  });
}

/** Rename the organisation. Administrators only. The response is the organisation, so the cache takes it directly. */
export function useRenameOrganisation(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => {
      const result = await api.organisations.update.v1({ id: organisationId, name });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: organisation => {
      client.setQueryData(organisationQueryOptions(organisationId).queryKey, organisation);
      return client.invalidateQueries({ queryKey: ['organisations', 'list'] });
    }
  });
}

/** Delete the organisation and everything in it. Global administrators only: anyone else is refused. */
export function useDeleteOrganisation(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const result = await api.organisations.delete.v1({ id: organisationId });
      if (result instanceof Error) throw result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['organisations', 'list'] })
  });
}
