import { queryOptions, useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import type { Rendition, ShowCreateParams, ShowUpdateParams } from '@conservationtv/studio-sdk';

import { api } from '@/lib/api';
import {
  moqReadOf,
  protocolReadOf,
  readRefetchInterval,
  readStaleTime,
  type MoqRead,
  type ProtocolRead
} from '@/queries/streams';

// An organisation's shows going out (apps/studio/api/src/routes/shows.ts): each with its output, the agent that runs
// OBS for it; its programme's encoding; the forwards that send the programme to channels; the previews that publish it
// to gateways to be read; and the recorder that has OBS record it. Every show follows the organisation's one broadcast
// for now (apps/studio/api/src/routes/broadcast.ts): what goes out differs by show, what is on screen doesn't yet.

/** The organisation's shows, oldest first, each with its output (null for none), forwards, previews and recorders. */
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
 * Where to watch a show's preview at conservation.tv over MoQ, with the short-lived credential that admits this
 * account, as a stream's delivery there is read (`moqReadQueryOptions`). A refusal comes back as its message, and it
 * is asked again a little before the credential expires.
 */
export const previewMoqReadQueryOptions = (organisationId: string, showId: string, previewId: string) =>
  // Typed by its key's kind rather than its literal shape, so a stream's read and a show's are one type to the parts.
  queryOptions<MoqRead, Error, MoqRead, QueryKey>({
    queryKey: ['shows', organisationId, 'moq-read', showId, previewId] as const,
    queryFn: async () =>
      moqReadOf(
        await api.organisations.shows.previews.connect.v1({
          id: organisationId,
          showId,
          previewId,
          action: 'read',
          protocol: 'moq'
        })
      ),
    staleTime: query => readStaleTime(query.state.data),
    refetchInterval: query => readRefetchInterval(query.state.data)
  });

/**
 * How this account reads a show's preview at one of the organisation's gateways by one protocol, as a stream's
 * delivery there is read (`exposureReadQueryOptions`): the URL and the token beside it, or why not. A preview offers
 * one rendition, `default`.
 */
export const previewReadQueryOptions = (
  organisationId: string,
  showId: string,
  previewId: string,
  protocol: string,
  rendition: Rendition
) =>
  // As moqReadQueryOptions: one type for a stream's read and a show's.
  queryOptions<ProtocolRead, Error, ProtocolRead, QueryKey>({
    queryKey: ['shows', organisationId, 'read', showId, previewId, protocol, rendition] as const,
    queryFn: async () =>
      protocolReadOf(
        await api.organisations.shows.previews.connect.v1({
          id: organisationId,
          showId,
          previewId,
          action: 'read',
          protocol,
          rendition
        })
      ),
    staleTime: query => readStaleTime(query.state.data),
    refetchInterval: query => readRefetchInterval(query.state.data)
  });

/**
 * Compose the organisation's broadcast from its streams, in a random order. Temporary, until a show has controls.
 * Everyone following the broadcast sees it as its next update, on every show; a stage still waiting for a first
 * composition picks it up when it next redials.
 */
export function useComposeBroadcast(organisationId: string) {
  return useMutation({
    mutationFn: async () => {
      const result = await api.organisations.show.compose({ id: organisationId });
      if (result instanceof Error) throw result;
    }
  });
}

/** Make a show, by name, its programme at the default encoding. Administrators only. */
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

/** Rename a show, or change its programme's encoding. */
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

/** Delete a show, with its output, forwards, previews and recorders: its agent stops running OBS for it. */
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
    }
  });
}

/** A show's output to set: the agent that is to run OBS for it. */
export interface ShowOutputChoice {
  showId: string;
  deviceId: string;
}

/** Choose the agent that runs OBS for a show, in place of any other. Refused for another show's output. */
export function useSetShowOutput(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ showId, deviceId }: ShowOutputChoice) => {
      const result = await api.organisations.shows.setOutput.v1({ id: organisationId, showId, deviceId });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['shows', organisationId] })
  });
}

/** Leave a show with no output: nothing sends it out until one is chosen again. */
export function useClearShowOutput(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (showId: string) => {
      const result = await api.organisations.shows.deleteOutput.v1({ id: organisationId, showId });
      if (result instanceof Error) throw result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['shows', organisationId] })
  });
}

/** A channel to forward a show to. */
export interface NewForward {
  showId: string;
  channelId: string;
}

/** Send a show's programme to a channel, on from the start. Once per channel. */
export function useCreateForward(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ showId, channelId }: NewForward) => {
      const result = await api.organisations.shows.forwards.create.v1({
        id: organisationId,
        showId,
        channelId,
        enabled: true
      });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['shows', organisationId] })
  });
}

/** A forward switched on or off. */
export interface ForwardSwitch {
  showId: string;
  forwardId: string;
  enabled: boolean;
}

/** Turn a forward on or off: one that is off isn't sent the programme, and the channel stays the show's. */
export function useUpdateForward(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ showId, forwardId, enabled }: ForwardSwitch) => {
      const result = await api.organisations.shows.forwards.update.v1({
        id: organisationId,
        showId,
        forwardId,
        enabled
      });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['shows', organisationId] })
  });
}

/** What names one of a show's forwards, previews or recorders, to remove it. */
export interface ShowPartRemoval {
  showId: string;
  partId: string;
}

/** Stop forwarding a show to a channel. The channel stays, for other shows. */
export function useDeleteForward(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ showId, partId }: ShowPartRemoval) => {
      const result = await api.organisations.shows.forwards.delete.v1({
        id: organisationId,
        showId,
        forwardId: partId
      });
      if (result instanceof Error) throw result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['shows', organisationId] })
  });
}

/** A gateway to preview a show at. */
export interface NewPreview {
  showId: string;
  gatewayId: string;
}

/** Have a show's output publish its programme to a gateway, to be read there. Once per gateway. */
export function useCreatePreview(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ showId, gatewayId }: NewPreview) => {
      const result = await api.organisations.shows.previews.create.v1({ id: organisationId, showId, gatewayId });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['shows', organisationId] })
  });
}

/** Stop publishing a show's programme to a gateway. */
export function useDeletePreview(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ showId, partId }: ShowPartRemoval) => {
      const result = await api.organisations.shows.previews.delete.v1({
        id: organisationId,
        showId,
        previewId: partId
      });
      if (result instanceof Error) throw result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['shows', organisationId] })
  });
}

/** Have OBS record a show's programme alongside streaming it, on its output's machine. */
export function useCreateShowRecorder(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (showId: string) => {
      const result = await api.organisations.shows.createRecorder.v1({ id: organisationId, showId, kind: 'obs' });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['shows', organisationId] })
  });
}

/** Stop recording a show. What OBS has recorded stays on its output's machine. */
export function useDeleteShowRecorder(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ showId, partId }: ShowPartRemoval) => {
      const result = await api.organisations.shows.deleteRecorder.v1({
        id: organisationId,
        showId,
        recorderId: partId
      });
      if (result instanceof Error) throw result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['shows', organisationId] })
  });
}
