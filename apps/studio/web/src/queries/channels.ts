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

// The output agent's metrics about a channel (`channel:<channelId>`), as @conservationtv/reports names them
// (channelMetrics): what the channel's platform says of it, read by the output of a show forwarded to it.
const CHANNEL_LIVE = 'channel.live';
const CHANNEL_VIEWERS = 'channel.viewers';

/** How far back a channel's latest platform state is looked for: a few of the output's report intervals. */
const PLATFORM_STATE_WINDOW_MS = 5 * 60_000;
/** The buckets it is read in: one per report interval. */
const PLATFORM_STATE_STEP_SECONDS = 60;

/** What a channel's platform last said of it, as a show's output reported it. */
export interface ChannelPlatformState {
  live: boolean;
  viewers: number | undefined;
  /** ISO 8601: the bucket it was reported in. */
  at: string;
}

/**
 * What the platforms of the given channels last said of them, by channel ID, as the outputs of the shows forwarded to
 * them reported it: whether each is live, and its viewers. One read across every channel's subject; a channel nobody
 * reported about in the last few minutes is absent. Read again every minute, as the outputs report.
 */
export const channelPlatformStateQueryOptions = (organisationId: string, channelIds: string[]) =>
  queryOptions({
    queryKey: ['channels', organisationId, 'platform-state', channelIds] as const,
    queryFn: async () => {
      if (channelIds.length === 0) return new Map<string, ChannelPlatformState>();
      const to = Date.now();
      const result = await api.organisations.subjects.metrics.query.v1({
        id: organisationId,
        subjectIds: channelIds.map(channelId => `channel:${channelId}`),
        names: [CHANNEL_LIVE, CHANNEL_VIEWERS],
        from: new Date(to - PLATFORM_STATE_WINDOW_MS).toISOString(),
        to: new Date(to).toISOString(),
        step: PLATFORM_STATE_STEP_SECONDS
      });
      if (result instanceof Error) throw result;
      return platformStatesOf(result.series, channelIds);
    },
    refetchInterval: 60_000
  });

/** A point of a metric series: when its bucket starts, and the last value reported in it. */
interface MetricPoint {
  at: string;
  last: number;
}

/** A metric series, as `metrics.query` returns it, as far as it is read here: about one subject, from one reporter. */
interface MetricSeries {
  subjectId: string;
  name: string;
  points: MetricPoint[];
}

/**
 * Each channel's latest live and viewers, from the series read: a channel with no `channel.live` point in them was not
 * reported about, and is left out; one whose viewers weren't reported has none.
 */
function platformStatesOf(series: MetricSeries[], channelIds: string[]): Map<string, ChannelPlatformState> {
  const states = new Map<string, ChannelPlatformState>();
  for (const channelId of channelIds) {
    const subjectId = `channel:${channelId}`;
    const live = latestOf(series, subjectId, CHANNEL_LIVE);
    if (live === undefined) continue;
    const viewers = latestOf(series, subjectId, CHANNEL_VIEWERS);
    states.set(channelId, { live: live.last > 0, viewers: viewers?.last, at: live.at });
  }
  return states;
}

/**
 * The latest point of the metric about the subject, whichever reporter reported it: an output replaced since may have
 * a series of its own. The API writes every bucket's time alike, as ISO 8601 in UTC, so later is greater.
 */
function latestOf(series: MetricSeries[], subjectId: string, name: string): MetricPoint | undefined {
  let latest: MetricPoint | undefined = undefined;
  for (const candidate of series) {
    // Only the metric's series about the subject, and of their points the one in the latest bucket.
    if (candidate.subjectId !== subjectId || candidate.name !== name) continue;
    for (const point of candidate.points) if (latest === undefined || point.at > latest.at) latest = point;
  }
  return latest;
}

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

/** Remove a channel, and its stream key with it. Every show's forward to it goes too. */
export function useDeleteChannel(organisationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (channelId: string) => {
      const result = await api.organisations.channels.delete.v1({ id: organisationId, channelId });
      if (result instanceof Error) throw result;
    },
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ['channels', organisationId] }),
        client.invalidateQueries({ queryKey: ['shows', organisationId] })
      ])
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
