import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type { AgentCreateParams, AgentUpdateParams } from '@conservationtv/studio-sdk';

import { api } from '@/lib/api';

// An organisation's agents: the programs on its networks that pull from cameras and deliver streams
// (apps/studio/api/src/routes/agents.ts). What an agent says about itself right now is asked of the agent directly
// (src/queries/agent-system.ts).

/** The organisation's agents, each with its device, the network it is on and whether it is that network's active one. */
export const agentListQueryOptions = (organisationId: string) =>
  queryOptions({
    queryKey: ['agents', organisationId, 'list'] as const,
    queryFn: async () => {
      const result = await api.organisations.agents.list.v1({ id: organisationId });
      if (result instanceof Error) throw result;
      return result.agents;
    }
  });

/** Add an agent to a network: its device is made with it. Administrators only. */
export function useCreateAgent(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (agent: Omit<AgentCreateParams, 'id'>) => {
      const result = await api.organisations.agents.create.v1({ id: organisationId, ...agent });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ['agents', organisationId] }),
        client.invalidateQueries({ queryKey: ['devices', organisationId] }),
        client.invalidateQueries({ queryKey: ['networks', organisationId] })
      ])
  });
}

/** Change an agent's priority: among a network's agents, the highest is preferred as its active one. */
export function useUpdateAgent(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (changes: Omit<AgentUpdateParams, 'id'>) => {
      const result = await api.organisations.agents.update.v1({ id: organisationId, ...changes });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['agents', organisationId] })
  });
}

/** Remove an agent, and its device with it. Refused while it is still relied on. */
export function useDeleteAgent(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (agentId: string) => {
      const result = await api.organisations.agents.delete.v1({ id: organisationId, agentId });
      if (result instanceof Error) throw result;
    },
    // Not waited on: the page that deleted it leaves at once, instead of showing "not found" while its list is read.
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['agents', organisationId] });
      void client.invalidateQueries({ queryKey: ['devices', organisationId] });
      void client.invalidateQueries({ queryKey: ['networks', organisationId] });
    }
  });
}
