import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { NotFoundError } from '@conservationtv/studio-sdk';

import { api } from '@/lib/api';

/**
 * Compose the organisation's broadcast from its streams, in a random order. Temporary, until a show has controls.
 * Everyone following the broadcast sees it as its next update; a stage still waiting for a first composition picks it
 * up when it next redials.
 */
export function useComposeBroadcast(organisationId: string) {
  return useMutation({
    mutationFn: async () => {
      const result = await api.organisations.show.compose({ id: organisationId });
      if (result instanceof Error) throw result;
    }
  });
}

/**
 * The device that sends the organisation's show out: an agent running OBS, forwarding the programme to every channel
 * that is on. Null while the show has no output, which the API answers as not found.
 */
export const showOutputQueryOptions = (organisationId: string) =>
  queryOptions({
    queryKey: ['show', organisationId, 'output'] as const,
    queryFn: async () => {
      const result = await api.organisations.show.output.get.v1({ id: organisationId });
      if (result instanceof NotFoundError) return null;
      if (result instanceof Error) throw result;
      return result;
    }
  });

/** Choose the agent that sends the show out. Administrators only. */
export function useSetShowOutput(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (deviceId: string) => {
      const result = await api.organisations.show.output.set.v1({ id: organisationId, deviceId });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: output => client.setQueryData(showOutputQueryOptions(organisationId).queryKey, output)
  });
}

/** Leave the show with no output: nothing sends it out until one is chosen again. */
export function useClearShowOutput(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const result = await api.organisations.show.output.delete.v1({ id: organisationId });
      if (result instanceof Error) throw result;
    },
    onSuccess: () => client.setQueryData(showOutputQueryOptions(organisationId).queryKey, null)
  });
}
