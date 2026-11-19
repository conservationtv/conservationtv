import { queryOptions, useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import {
  HttpError,
  type OutputCreateParams,
  type OutputUpdateParams,
  type Rendition
} from '@conservationtv/studio-sdk';

import { api } from '@/lib/api';
import {
  moqReadOf,
  protocolReadOf,
  readRefetchInterval,
  readStaleTime,
  type MoqRead,
  type ProtocolRead
} from '@/queries/streams';

// An organisation's outputs (apps/studio/api/src/routes/outputs.ts): each one OBS on one agent, with that agent; its
// programme's encoding; the forwards that send the programme to channels; the previews that publish it to gateways to
// be read; and the recorder that has OBS record it. What is on screen is driven by the show it follows
// (src/queries/shows.ts), or, under `external` control, by something outside the studio.
//
// The shows list names the outputs following each show, so whatever changes which show an output follows reads the
// shows again too.

/** The organisation's outputs, oldest first, each with its device (null for none), forwards, previews and recorders. */
export const outputListQueryOptions = (organisationId: string) =>
  queryOptions({
    queryKey: ['outputs', organisationId, 'list'] as const,
    queryFn: async () => {
      const result = await api.organisations.outputs.list.v1({ id: organisationId });
      if (result instanceof Error) throw result;
      return result.outputs;
    }
  });

/**
 * How something outside the studio drives an output's OBS, as its agent last reported it: obs-websocket's port and
 * password, the scene collection OBS runs, and where OBS reads an exposure. Administrators only. Null where the API
 * has nothing to say: before the agent has reported, or for anyone but an administrator.
 */
export const outputControlQueryOptions = (organisationId: string, outputId: string) =>
  queryOptions({
    queryKey: ['outputs', organisationId, 'control', outputId] as const,
    queryFn: async () => {
      const result = await api.organisations.outputs.control.get.v1({ id: organisationId, outputId });
      if (result instanceof HttpError && result.status === 404) return null;
      if (result instanceof Error) throw result;
      return result;
    }
  });

/**
 * Where to watch an output's preview at conservation.tv over MoQ, with the short-lived credential that admits this
 * account, as a stream's delivery there is read (`moqReadQueryOptions`). A refusal comes back as its message, and it
 * is asked again a little before the credential expires.
 */
export const previewMoqReadQueryOptions = (organisationId: string, outputId: string, previewId: string) =>
  // Typed by its key's kind rather than its literal shape, so a stream's read and an output's are one type to the
  // parts.
  queryOptions<MoqRead, Error, MoqRead, QueryKey>({
    queryKey: ['outputs', organisationId, 'moq-read', outputId, previewId] as const,
    queryFn: async () =>
      moqReadOf(
        await api.organisations.outputs.previews.connect.v1({
          id: organisationId,
          outputId,
          previewId,
          action: 'read',
          protocol: 'moq'
        })
      ),
    staleTime: query => readStaleTime(query.state.data),
    refetchInterval: query => readRefetchInterval(query.state.data)
  });

/**
 * How this account reads an output's preview at one of the organisation's gateways by one protocol, as a stream's
 * delivery there is read (`exposureReadQueryOptions`): the URL and the token beside it, or why not. A preview offers
 * one rendition, `default`.
 */
export const previewReadQueryOptions = (
  organisationId: string,
  outputId: string,
  previewId: string,
  protocol: string,
  rendition: Rendition
) =>
  // As moqReadQueryOptions: one type for a stream's read and an output's.
  queryOptions<ProtocolRead, Error, ProtocolRead, QueryKey>({
    queryKey: ['outputs', organisationId, 'read', outputId, previewId, protocol, rendition] as const,
    queryFn: async () =>
      protocolReadOf(
        await api.organisations.outputs.previews.connect.v1({
          id: organisationId,
          outputId,
          previewId,
          action: 'read',
          protocol,
          rendition
        })
      ),
    staleTime: query => readStaleTime(query.state.data),
    refetchInterval: query => readRefetchInterval(query.state.data)
  });

/** Make an output by name, following a show, none, or driven from outside, its programme at the default encoding. */
export function useCreateOutput(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (output: Omit<OutputCreateParams, 'id'>) => {
      const result = await api.organisations.outputs.create.v1({ id: organisationId, ...output });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ['outputs', organisationId] }),
        client.invalidateQueries({ queryKey: ['shows', organisationId] })
      ])
  });
}

/** Rename an output, change its programme's encoding, the show it follows, or who drives it. */
export function useUpdateOutput(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (changes: Omit<OutputUpdateParams, 'id'>) => {
      const result = await api.organisations.outputs.update.v1({ id: organisationId, ...changes });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ['outputs', organisationId] }),
        client.invalidateQueries({ queryKey: ['shows', organisationId] })
      ])
  });
}

/** Delete an output, with its device, forwards, previews and recorders: its agent stops running OBS for it. */
export function useDeleteOutput(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (outputId: string) => {
      const result = await api.organisations.outputs.delete.v1({ id: organisationId, outputId });
      if (result instanceof Error) throw result;
    },
    // Not waited on: the page that deleted it leaves at once, instead of showing "not found" while its list is read.
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['outputs', organisationId] });
      void client.invalidateQueries({ queryKey: ['shows', organisationId] });
    }
  });
}

/** An output's device to set: the agent that is to run its OBS. */
export interface OutputDeviceChoice {
  outputId: string;
  deviceId: string;
}

/** Choose the agent that runs an output's OBS, in place of any other. Refused for another output's agent. */
export function useSetOutputDevice(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ outputId, deviceId }: OutputDeviceChoice) => {
      const result = await api.organisations.outputs.setDevice.v1({ id: organisationId, outputId, deviceId });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['outputs', organisationId] })
  });
}

/** Leave an output with no agent: nothing sends it out until one is chosen again. */
export function useClearOutputDevice(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (outputId: string) => {
      const result = await api.organisations.outputs.deleteDevice.v1({ id: organisationId, outputId });
      if (result instanceof Error) throw result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['outputs', organisationId] })
  });
}

/** A channel to forward an output to. */
export interface NewForward {
  outputId: string;
  channelId: string;
}

/** Send an output's programme to a channel, on from the start. Once per channel. */
export function useCreateForward(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ outputId, channelId }: NewForward) => {
      const result = await api.organisations.outputs.forwards.create.v1({
        id: organisationId,
        outputId,
        channelId,
        enabled: true
      });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['outputs', organisationId] })
  });
}

/** A forward switched on or off. */
export interface ForwardSwitch {
  outputId: string;
  forwardId: string;
  enabled: boolean;
}

/** Turn a forward on or off: one that is off isn't sent the programme, and the channel stays the output's. */
export function useUpdateForward(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ outputId, forwardId, enabled }: ForwardSwitch) => {
      const result = await api.organisations.outputs.forwards.update.v1({
        id: organisationId,
        outputId,
        forwardId,
        enabled
      });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['outputs', organisationId] })
  });
}

/** What names one of an output's forwards, previews or recorders, to remove it. */
export interface OutputPartRemoval {
  outputId: string;
  partId: string;
}

/** Stop forwarding an output to a channel. The channel stays, for other outputs. */
export function useDeleteForward(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ outputId, partId }: OutputPartRemoval) => {
      const result = await api.organisations.outputs.forwards.delete.v1({
        id: organisationId,
        outputId,
        forwardId: partId
      });
      if (result instanceof Error) throw result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['outputs', organisationId] })
  });
}

/** A gateway to preview an output at. */
export interface NewPreview {
  outputId: string;
  gatewayId: string;
}

/** Have an output publish its programme to a gateway, to be read there. Once per gateway. */
export function useCreatePreview(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ outputId, gatewayId }: NewPreview) => {
      const result = await api.organisations.outputs.previews.create.v1({ id: organisationId, outputId, gatewayId });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['outputs', organisationId] })
  });
}

/** Stop publishing an output's programme to a gateway. */
export function useDeletePreview(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ outputId, partId }: OutputPartRemoval) => {
      const result = await api.organisations.outputs.previews.delete.v1({
        id: organisationId,
        outputId,
        previewId: partId
      });
      if (result instanceof Error) throw result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['outputs', organisationId] })
  });
}

/** Have OBS record an output's programme alongside streaming it, on its agent's machine. */
export function useCreateOutputRecorder(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (outputId: string) => {
      const result = await api.organisations.outputs.createRecorder.v1({ id: organisationId, outputId, kind: 'obs' });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['outputs', organisationId] })
  });
}

/** Stop recording an output. What OBS has recorded stays on its agent's machine. */
export function useDeleteOutputRecorder(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ outputId, partId }: OutputPartRemoval) => {
      const result = await api.organisations.outputs.deleteRecorder.v1({
        id: organisationId,
        outputId,
        recorderId: partId
      });
      if (result instanceof Error) throw result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['outputs', organisationId] })
  });
}
