import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Channel } from '@conservationtv/studio-sdk';

import type { RtmpChannel } from '@/forms/schemas';
import { api } from '@/lib/api';

// Where the organisation's shows go out to (apps/studio/api/src/routes/channels.ts). The studio lists, adds and removes
// channels, and starts connecting Twitch; it never reads a channel's stream key or tokens. Which shows go out to a
// channel is each show's forwards.

/** The organisation's channels, oldest first, and whether this deployment can connect Twitch. */
export const channelListQueryOptions = (organisationId: string) =>
  queryOptions({
    queryKey: ['channels', organisationId, 'list'] as const,
    queryFn: async () => {
      const result = await api.organisations.channels.list.v1({ id: organisationId });
      if (result instanceof Error) throw result;
      return result;
    }
  });

/** Add an RTMP(S) destination by its server URL and stream key. */
export function useCreateRtmpChannel(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (channel: RtmpChannel): Promise<Channel> => {
      const result = await api.organisations.channels.create.v1({ id: organisationId, ...channel });
      if (result instanceof Error) throw result;
      return result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['channels', organisationId] })
  });
}

/** Remove a channel, and its stream key with it. */
export function useDeleteChannel(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (channelId: string) => {
      const result = await api.organisations.channels.delete.v1({ id: organisationId, channelId });
      if (result instanceof Error) throw result;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['channels', organisationId] })
  });
}

/**
 * Leave for Twitch to approve the studio reading the channel's stream key. Twitch returns to the API, which connects
 * the channel and comes back to the channels page.
 */
export function useConnectTwitch(organisationId: string) {
  return useMutation({
    mutationFn: async () => {
      const result = await api.organisations.channels.twitch.authorize.v1({ id: organisationId });
      if (result instanceof Error) throw result;
      window.location.assign(result.url);
    }
  });
}
