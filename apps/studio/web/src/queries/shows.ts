import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type { ShowCreateParams, ShowUpdateParams } from '@conservationtv/studio-sdk';

import { api } from '@/lib/api';

// An organisation's shows (apps/studio/api/src/routes/shows.ts): what is on screen, each composed by an object of its
// own and followed by name, with the outputs following it. How a show goes out is each of those outputs'
// (src/queries/outputs.ts).

/** The organisation's shows, oldest first, each with the outputs following it. */
export const showListQueryOptions = (organisationId: string) =>
  queryOptions({
    queryKey: ['shows', organisationId, 'list'] as const,
    queryFn: async () => {
      const result = await api.organisations.shows.list.v1({ id: organisationId });
      if (result instanceof Error) throw result;
      return result.shows;
    }
  });

/**
 * Compose a show from the organisation's streams, in a random order. Temporary, until a show has controls. Everyone
 * following the show sees it as its next update, the outputs following it too; a stage still waiting for a first
 * composition picks it up when it next redials. What it places changes, so the topology is read again.
 */
export function useComposeShow(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (showId: string) => {
      const result = await api.organisations.shows.compose({ id: organisationId, showId });
      if (result instanceof Error) throw result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['topology', organisationId] })
  });
}

/** Make a show, by name. Administrators only. */
export function useCreateShow(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (show: Omit<ShowCreateParams, 'id'>) => {
      const result = await api.organisations.shows.create.v1({ id: organisationId, ...show });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['shows', organisationId] })
  });
}

/** Rename a show. */
export function useUpdateShow(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (changes: Omit<ShowUpdateParams, 'id'>) => {
      const result = await api.organisations.shows.update.v1({ id: organisationId, ...changes });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['shows', organisationId] })
  });
}

/** Delete a show. The outputs following it follow nothing until given another, so they are read again too. */
export function useDeleteShow(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (showId: string) => {
      const result = await api.organisations.shows.delete.v1({ id: organisationId, showId });
      if (result instanceof Error) throw result;
    },
    // Not waited on: the page that deleted it leaves at once, instead of showing "not found" while its list is read.
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['shows', organisationId] });
      void client.invalidateQueries({ queryKey: ['outputs', organisationId] });
    }
  });
}
