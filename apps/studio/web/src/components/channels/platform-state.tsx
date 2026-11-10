import type { FC } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import type { Channel } from '@conservationtv/studio-sdk';

import { StatusLabel } from '@/components/common/status';
import { useOrganisationId } from '@/hooks/use-organisation';
import { channelListQueryOptions, channelPlatformStateQueryOptions } from '@/queries/channels';

// What a channel's platform last said of it (live or offline, and its viewers), as the output of a show forwarded to
// it reported it about `channel:<channelId>` (apps/agent/core/src/runtimes/channel-stats.ts). Only Twitch
// channels say anything. Every channel's is one read, of the organisation's Twitch channels, which each row selects
// its own from, so the Channels page and a show's channel rows share it.

export interface ChannelPlatformStateProps {
  channelId: string;
}

/**
 * The channel's platform state as a dot and a few words: "Live · 12 viewers", "Offline", or nothing for a channel no
 * output has reported about in the last few minutes, or one that says nothing (an RTMP destination). Suspends until
 * the channels' states are read.
 */
export const ChannelPlatformState: FC<ChannelPlatformStateProps> = ({ channelId }) => {
  const organisationId = useOrganisationId();
  const { data: channelIds } = useSuspenseQuery({
    ...channelListQueryOptions(organisationId),
    select: twitchChannelIdsOf
  });
  const { data: state } = useSuspenseQuery({
    ...channelPlatformStateQueryOptions(organisationId, channelIds),
    select: states => states.get(channelId)
  });
  if (state === undefined) return null;
  if (!state.live) return <StatusLabel status="unknown">Offline</StatusLabel>;
  return <StatusLabel status="ok">{liveLabelOf(state.viewers)}</StatusLabel>;
};

/** What `organisations.channels.list` answers, as far as its channels. */
interface ListedChannels {
  channels: Channel[];
}

/** The IDs of the organisation's Twitch channels, the ones whose platform says anything. */
function twitchChannelIdsOf(listed: ListedChannels): string[] {
  const twitch = listed.channels.filter(channel => channel.kind === 'twitch');
  return twitch.map(channel => channel.id);
}

/** "Live", with its viewers when they were reported. */
function liveLabelOf(viewers: number | undefined): string {
  if (viewers === undefined) return 'Live';
  const rounded = Math.round(viewers);
  return `Live · ${String(rounded)} ${rounded === 1 ? 'viewer' : 'viewers'}`;
}
