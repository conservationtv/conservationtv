import { z } from 'zod';
import { useEnvironment } from '../env/env.ts';
import { ApiFailure } from '../errors.ts';
import type { TwitchCredentials } from './kinds.ts';

// Twitch, as a channel: connected with the OAuth authorization code flow by an administrator in the studio, after which
// the API reads the stream key itself whenever the show's output asks for an ingest. Needs a Twitch application
// (TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET) whose redirect URL is this API's /channels/twitch/callback.
//
// The program is forwarded to Twitch's global ingest over RTMPS, as MediaMTX's forwarding guide gives it.

const AUTHORIZE_URL = 'https://id.twitch.tv/oauth2/authorize';
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const HELIX = 'https://api.twitch.tv/helix';
/** Where the program is sent: Twitch's global ingest, over RTMPS. */
export const TWITCH_INGEST = 'rtmps://ingest.global-contribute.live-video.net/app';
/** Reading the stream key is all a broadcast needs. */
const SCOPES = ['channel:read:stream_key'];
/** How long before an access token expires to refresh it. */
const REFRESH_BEFORE_MS = 5 * 60_000;

/** The deployment's Twitch application. */
function twitchApp() {
  const environment = useEnvironment();
  const { TWITCH_CLIENT_ID: clientId, TWITCH_CLIENT_SECRET: clientSecret, APP_URL } = environment.variables;
  const redirectUri = new URL('/channels/twitch/callback', APP_URL).href;
  return { clientId, clientSecret, redirectUri };
}

/** Where to send the administrator to connect their Twitch channel, carrying `state` back to the callback. */
export function twitchAuthorizeUrl(state: string): string {
  const { clientId, redirectUri } = twitchApp();
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    state,
    force_verify: 'true'
  }).toString();
  return url.href;
}

const TokenSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
  scope: z.array(z.string()).default([])
});
export type Token = z.output<typeof TokenSchema>;

async function token(parameters: Record<string, string>): Promise<TwitchCredentials> {
  const { clientId, clientSecret } = twitchApp();
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...parameters })
  });
  if (!response.ok)
    throw new ApiFailure('channel_unavailable', { cause: new Error(`Twitch token: HTTP ${response.status}`) });
  const body = TokenSchema.parse(await response.json());
  const environment = useEnvironment();
  return {
    kind: 'twitch',
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: environment.clock() + body.expires_in * 1000,
    scopes: body.scope
  };
}

/** The tokens for an authorization code from the callback. */
export function exchangeTwitchCode(code: string): Promise<TwitchCredentials> {
  const { redirectUri } = twitchApp();
  return token({ code, grant_type: 'authorization_code', redirect_uri: redirectUri });
}

/** `credentials`, refreshed if the access token expires soon; the same object when it doesn't. */
export async function freshTwitchCredentials(credentials: TwitchCredentials): Promise<TwitchCredentials> {
  const environment = useEnvironment();
  if (credentials.expiresAt - environment.clock() > REFRESH_BEFORE_MS) return credentials;
  return token({ grant_type: 'refresh_token', refresh_token: credentials.refreshToken });
}

async function helix<T extends z.ZodType>(path: string, accessToken: string, schema: T): Promise<z.output<T>> {
  const { clientId } = twitchApp();
  const response = await fetch(`${HELIX}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}`, 'Client-Id': clientId }
  });
  if (!response.ok)
    throw new ApiFailure('channel_unavailable', { cause: new Error(`Twitch ${path}: HTTP ${response.status}`) });
  return schema.parse(await response.json());
}

const UsersSchema = z.object({
  data: z.array(z.object({ id: z.string(), login: z.string(), display_name: z.string() })).min(1)
});
export type Users = z.output<typeof UsersSchema>;

/** The broadcaster the tokens belong to. */
export async function twitchBroadcaster(credentials: TwitchCredentials) {
  const users = await helix('/users', credentials.accessToken, UsersSchema);
  const [user] = users.data;
  return { id: user!.id, login: user!.login, displayName: user!.display_name };
}

const StreamKeySchema = z.object({ data: z.array(z.object({ stream_key: z.string() })).min(1) });
export type StreamKey = z.output<typeof StreamKeySchema>;

/** The broadcaster's current stream key. */
export async function twitchStreamKey(credentials: TwitchCredentials, broadcasterId: string): Promise<string> {
  const query = new URLSearchParams({ broadcaster_id: broadcasterId }).toString();
  const keys = await helix(`/streams/key?${query}`, credentials.accessToken, StreamKeySchema);
  return keys.data[0]!.stream_key;
}
