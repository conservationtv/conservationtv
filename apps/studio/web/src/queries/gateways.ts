import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type { GatewayCreateParams, GatewayUpdateParams } from '@conservationtv/studio-sdk';

import { api } from '@/lib/api';

// Gateways are where a stream is delivered: conservation.tv itself, which every organisation has, and the MediaMTX
// servers an organisation's agents run on its own networks (apps/studio/api/src/routes/gateways.ts).

/** The built-in gateways, then the organisation's own. */
export const gatewayListQueryOptions = (organisationId: string) =>
  queryOptions({
    queryKey: ['gateways', organisationId, 'list'] as const,
    queryFn: async () => {
      const result = await api.organisations.gateways.list.v1({ id: organisationId });
      if (result instanceof Error) throw result;
      return result.gateways;
    }
  });

/** Where a gateway can be reached right now, by protocol, as the agent running it registered. */
export const gatewayEndpointListQueryOptions = (organisationId: string, gatewayId: string) =>
  queryOptions({
    queryKey: ['gateways', organisationId, 'endpoints', gatewayId] as const,
    queryFn: async () => {
      const result = await api.organisations.gateways.listEndpoints.v1({ id: organisationId, gatewayId });
      if (result instanceof Error) throw result;
      return result.endpoints;
    }
  });

/** Add a gateway of the organisation's own. Administrators only. */
export function useCreateGateway(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (gateway: Omit<GatewayCreateParams, 'id'>) => {
      const result = await api.organisations.gateways.create.v1({ id: organisationId, ...gateway });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['gateways', organisationId] })
  });
}

/** Rename a gateway, move it to another network, or replace its settings. */
export function useUpdateGateway(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (changes: Omit<GatewayUpdateParams, 'id'>) => {
      const result = await api.organisations.gateways.update.v1({ id: organisationId, ...changes });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['gateways', organisationId] })
  });
}

/** Delete a gateway. Refused while a stream is still delivered to it. */
export function useDeleteGateway(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (gatewayId: string) => {
      const result = await api.organisations.gateways.delete.v1({ id: organisationId, gatewayId });
      if (result instanceof Error) throw result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['gateways', organisationId] })
  });
}
