import { z } from 'zod';

// The kinds of channel a broadcast goes out to (src/db/schemas/channels.ts), and what each keeps to reach it.
//
//   twitch  connected by OAuth; the stream key is read from Twitch when an ingest is asked for (src/channels/twitch.ts)
//   rtmp    an RTMP(S) server URL and stream key entered by hand: any service that takes RTMP, Twitch included

export const CHANNEL_KINDS = ['twitch', 'rtmp'] as const;
export const ChannelKindSchema = z.enum(CHANNEL_KINDS);
export type ChannelKind = z.output<typeof ChannelKindSchema>;

/** A Twitch connection's OAuth tokens, and when the access token expires. */
export const TwitchCredentialsSchema = z.object({
  kind: z.literal('twitch'),
  accessToken: z.string(),
  refreshToken: z.string(),
  /** Epoch milliseconds. */
  expiresAt: z.number(),
  scopes: z.array(z.string())
});
export type TwitchCredentials = z.output<typeof TwitchCredentialsSchema>;

/** An RTMP(S) destination: the server URL, with its application, and the stream key. */
export const RtmpCredentialsSchema = z.object({
  kind: z.literal('rtmp'),
  url: z.string(),
  key: z.string()
});
export type RtmpCredentials = z.output<typeof RtmpCredentialsSchema>;

export const ChannelCredentialsSchema = z.discriminatedUnion('kind', [TwitchCredentialsSchema, RtmpCredentialsSchema]);
export type ChannelCredentials = z.output<typeof ChannelCredentialsSchema>;
