import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type { DeviceUpdateParams } from '@conservationtv/studio-sdk';

import { api } from '@/lib/api';

// An organisation's devices, of every kind: agents, cameras and members' browsers each have one, which is their
// identity (apps/studio/api/src/routes/devices.ts). Agents and cameras are made and removed as what they are
// (src/queries/agents.ts, src/queries/cameras.ts); here a device is read, renamed and moved between networks.

/** The organisation's devices, of every kind. */
export const deviceListQueryOptions = (organisationId: string) =>
  queryOptions({
    queryKey: ['devices', organisationId, 'list'] as const,
    queryFn: async () => {
      const result = await api.organisations.devices.list.v1({ id: organisationId });
      if (result instanceof Error) throw result;
      return result.devices;
    }
  });

/** Where a device last said it can be reached on its own network, as it found on its interfaces. */
export const deviceAddressListQueryOptions = (organisationId: string, deviceId: string) =>
  queryOptions({
    queryKey: ['devices', organisationId, 'addresses', deviceId] as const,
    queryFn: async () => {
      const result = await api.organisations.devices.listAddresses.v1({ id: organisationId, deviceId });
      if (result instanceof Error) throw result;
      return result.addresses;
    }
  });

/**
 * Rename a device, or move it to another network. Whatever is drawn from devices (agents, cameras, stream topologies)
 * carries their names, so those are read again too.
 */
export function useUpdateDevice(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (changes: Omit<DeviceUpdateParams, 'id'>) => {
      const result = await api.organisations.devices.update.v1({ id: organisationId, ...changes });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ['devices', organisationId] }),
        client.invalidateQueries({ queryKey: ['agents', organisationId] }),
        client.invalidateQueries({ queryKey: ['cameras', organisationId] })
      ])
  });
}

/**
 * Read a device's key pair, private key included, to set an agent up with. Administrators only, and asked for on
 * demand: a mutation rather than a query, so the private key is never kept in the cache.
 */
export function useRevealKeyPair(organisationId: string) {
  return useMutation({
    mutationFn: async (deviceId: string) => {
      const result = await api.organisations.devices.getKeyPair.v1({ id: organisationId, deviceId });
      if (result instanceof Error) throw result;
      return result;
    }
  });
}
