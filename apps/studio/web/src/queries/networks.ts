import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type { NetworkCreateParams, NetworkSetActiveAgentParams, NetworkUpdateParams } from '@conservationtv/studio-sdk';

import { api } from '@/lib/api';

// An organisation's networks: the sites its cameras and agents are on (apps/studio/api/src/routes/networks.ts).

/** The organisation's networks, each with the agent active on it, if one is. */
export const networkListQueryOptions = (organisationId: string) =>
  queryOptions({
    queryKey: ['networks', organisationId, 'list'] as const,
    queryFn: async () => {
      const result = await api.organisations.networks.list.v1({ id: organisationId });
      if (result instanceof Error) throw result;
      return result.networks;
    }
  });

/** Add a network. Administrators only. */
export function useCreateNetwork(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (network: Omit<NetworkCreateParams, 'id'>) => {
      const result = await api.organisations.networks.create.v1({ id: organisationId, ...network });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['networks', organisationId] })
  });
}

/** Rename a network. */
export function useUpdateNetwork(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (changes: Omit<NetworkUpdateParams, 'id'>) => {
      const result = await api.organisations.networks.update.v1({ id: organisationId, ...changes });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['networks', organisationId] })
  });
}

/**
 * Choose which of a network's agents is active: the one that delivers its streams. `agentId: null` leaves it with
 * none. The agents' own `active` flags follow, so their list is read again too.
 */
export function useSetActiveAgent(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (choice: Omit<NetworkSetActiveAgentParams, 'id'>) => {
      const result = await api.organisations.networks.setActiveAgent.v1({ id: organisationId, ...choice });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ['networks', organisationId] }),
        client.invalidateQueries({ queryKey: ['agents', organisationId] })
      ])
  });
}

/** Delete a network. Refused while anything is still on it. */
export function useDeleteNetwork(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (networkId: string) => {
      const result = await api.organisations.networks.delete.v1({ id: organisationId, networkId });
      if (result instanceof Error) throw result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['networks', organisationId] })
  });
}
