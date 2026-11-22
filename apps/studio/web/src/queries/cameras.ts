import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  CameraCreateParams,
  CameraUpdateParams,
  PresetCreateParams,
  PresetDeleteParams,
  PresetUpdateParams,
  ThumbnailDeleteParams,
  ThumbnailSetParams
} from '@conservationtv/studio-sdk';

import { api } from '@/lib/api';

// An organisation's cameras: how each is reached (an Axis camera's host, or any RTSP URL), and whether it is in use
// (apps/studio/api/src/routes/cameras.ts). A camera's credentials are written but never read back. From the
// operations' second version a camera comes with what else it is called in chat (its aliases) and the positions saved
// for it (its presets), which are added, changed and removed one at a time. A preset may keep a picture of what the
// camera saw from it (its thumbnail), set and removed on its own.

/** The organisation's cameras, each with its device, its settings, its state, its aliases and its presets. */
export const cameraListQueryOptions = (organisationId: string) =>
  queryOptions({
    queryKey: ['cameras', organisationId, 'list'] as const,
    queryFn: async () => {
      const result = await api.organisations.cameras.list.v2({ id: organisationId });
      if (result instanceof Error) throw result;
      return result.cameras;
    }
  });

/** Add a camera: its device is made with it. Administrators only. */
export function useCreateCamera(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (camera: Omit<CameraCreateParams, 'id'>) => {
      const result = await api.organisations.cameras.create.v2({ id: organisationId, ...camera });
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

/**
 * Change how a camera is reached, its credentials, its state, or what else it is called in chat: its aliases are
 * replaced whole, and refused when another camera is already called by one. Its name and network are its device's.
 */
export function useUpdateCamera(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (changes: Omit<CameraUpdateParams, 'id'>) => {
      const result = await api.organisations.cameras.update.v2({ id: organisationId, ...changes });
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

/** Save a position of a camera under a name. Refused when the camera already has a preset of that name. */
export function useCreatePreset(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (preset: Omit<PresetCreateParams, 'id'>) => {
      const result = await api.organisations.cameras.presets.create.v1({ id: organisationId, ...preset });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['cameras', organisationId] })
  });
}

/** Rename a preset, or save another position under its name. */
export function useUpdatePreset(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (changes: Omit<PresetUpdateParams, 'id'>) => {
      const result = await api.organisations.cameras.presets.update.v1({ id: organisationId, ...changes });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['cameras', organisationId] })
  });
}

/** Remove a preset. A chat command that names it finds nothing to point the camera at. */
export function useDeletePreset(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (preset: Omit<PresetDeleteParams, 'id'>) => {
      const result = await api.organisations.cameras.presets.delete.v1({ id: organisationId, ...preset });
      if (result instanceof Error) throw result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['cameras', organisationId] })
  });
}

/**
 * The key of what is done to a camera's presets without a dialog to say how it went: going to one, and keeping or
 * removing one's picture. Whatever shows the presets reads the last of them from the mutation cache, and says so
 * when it failed.
 */
export const presetActionMutationKey = (organisationId: string, cameraId: string) =>
  ['cameras', organisationId, 'preset-actions', cameraId] as const;

/** A picture to keep as a preset's thumbnail: its type, and its bytes as base64. */
export type PresetPicture = Pick<ThumbnailSetParams, 'contentType' | 'data'>;

/** A preset, and how to take the picture to keep for it. */
export interface PresetPictureCapture {
  presetId: string;
  /** Takes the picture, or says there is none to take (null). It may throw, where the picture can't be read. */
  capture: () => PresetPicture | null;
}

/**
 * Keep a picture as a preset's thumbnail, taken as this runs. Where there is no picture to take the preset is left
 * without one, which is not a failure; a picture that can't be taken or kept is one, said in a line of its own, since
 * the preset itself is already saved.
 */
export function useKeepPresetPicture(organisationId: string, cameraId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationKey: presetActionMutationKey(organisationId, cameraId),
    mutationFn: async ({ presetId, capture }: PresetPictureCapture) => {
      // Taking the picture and sending it fail the same way, as the preset being left without one; no picture to
      // take is not a failure at all.
      try {
        const picture = capture();
        if (picture === null) return null;
        const result = await api.organisations.cameras.presets.thumbnail.set.v1({
          id: organisationId,
          cameraId,
          presetId,
          ...picture
        });
        if (result instanceof Error) throw result;
        return result;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`The preset is saved, but without a picture: ${reason}`, { cause: error });
      }
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['cameras', organisationId] })
  });
}

/** Remove a preset's thumbnail, leaving the preset. */
export function useRemovePresetPicture(organisationId: string, cameraId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationKey: presetActionMutationKey(organisationId, cameraId),
    mutationFn: async (presetId: ThumbnailDeleteParams['presetId']) => {
      const result = await api.organisations.cameras.presets.thumbnail.delete.v1({
        id: organisationId,
        cameraId,
        presetId
      });
      if (result instanceof Error) throw result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['cameras', organisationId] })
  });
}
