import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type { CameraCreateParams, CameraUpdateParams } from '@conservationtv/studio-sdk';

import { api } from '@/lib/api';

// An organisation's cameras: how each is reached (an Axis camera's host, or any RTSP URL), and whether it is in use
// (apps/studio/api/src/routes/cameras.ts). A camera's credentials are written but never read back.

/** The organisation's cameras, each with its device, its settings and its state. */
export const cameraListQueryOptions = (organisationId: string) =>
  queryOptions({
    queryKey: ['cameras', organisationId, 'list'] as const,
    queryFn: async () => {
      const result = await api.organisations.cameras.list.v1({ id: organisationId });
      if (result instanceof Error) throw result;
      return result.cameras;
    }
  });

/** Add a camera: its device is made with it. Administrators only. */
export function useCreateCamera(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (camera: Omit<CameraCreateParams, 'id'>) => {
      const result = await api.organisations.cameras.create.v1({ id: organisationId, ...camera });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ['cameras', organisationId] }),
        client.invalidateQueries({ queryKey: ['devices', organisationId] })
      ])
  });
}

/** Change how a camera is reached, its credentials, or its state. Its name and network are its device's. */
export function useUpdateCamera(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (changes: Omit<CameraUpdateParams, 'id'>) => {
      const result = await api.organisations.cameras.update.v1({ id: organisationId, ...changes });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['cameras', organisationId] })
  });
}

/** Remove a camera, and its device with it. Refused while a stream still uses it as its source. */
export function useDeleteCamera(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (cameraId: string) => {
      const result = await api.organisations.cameras.delete.v1({ id: organisationId, cameraId });
      if (result instanceof Error) throw result;
    },
    // Not waited on: the page that deleted it leaves at once, instead of showing "not found" while its list is read.
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['cameras', organisationId] });
      void client.invalidateQueries({ queryKey: ['devices', organisationId] });
    }
  });
}
