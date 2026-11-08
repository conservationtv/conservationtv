import { type Context, Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { exchangeTwitchCode, twitchBroadcaster } from '../channels/twitch.ts';
import { transaction } from '../db/transaction.ts';
import { useEnvironment } from '../env/env.ts';
import { requirePrincipal, useUser } from '../middleware/principal.ts';
import { connectTwitchChannel } from '../services/channels.ts';
import { connectStateKey, ConnectStateSchema } from './channels.ts';

const TwitchCallbackQuerySchema = z.object({
  state: z.string().optional(),
  code: z.string().optional(),
  error: z.string().optional()
});
export type TwitchCallbackQuery = z.output<typeof TwitchCallbackQuerySchema>;

// Where Twitch sends the browser back to after an administrator approves (or refuses) the studio, from
// `organisations.channels.twitch.authorize` (src/routes/channels.ts). A browser navigation, not an operation: it
// connects the channel as the signed-in account, then returns to the studio's channels page, with `?connected=twitch`
// or `?error=<reason>`.

/** The studio's channels page for the organisation, with `outcome` in its query. */
function channelsPage(organisationId: string | undefined, outcome: Record<string, string>) {
  const environment = useEnvironment();
  const [webOrigin] = environment.variables.WEB_ORIGINS;
  const path = organisationId ? `/organisations/${organisationId}/channels` : '/';
  const url = new URL(path, webOrigin);
  url.search = new URLSearchParams(outcome).toString();
  return url.href;
}

/** The connection `state` names, used up so a second visit finds nothing: if it is the signed-in account's. */
async function takeConnectState(state: string | undefined) {
  if (!state) return undefined;
  const environment = useEnvironment();
  const key = connectStateKey(state);
  const stored = await environment.cache.get(key);
  if (!stored) return undefined;
  await environment.cache.put(key, '', 1);
  const parsed = ConnectStateSchema.safeParse(JSON.parse(stored));
  const user = useUser();
  return parsed.success && parsed.data.userId === user.id ? parsed.data : undefined;
}

/**
 * Twitch's return. An unknown or someone else's state goes back to the studio as expired, a refusal on Twitch as
 * refused, and a failure to read the tokens or the broadcaster, or to keep them, as failed; only then is the channel
 * connected.
 */
async function twitchCallback(c: Context) {
  const query = TwitchCallbackQuerySchema.parse(c.req.query());
  const remembered = await takeConnectState(query.state);
  if (!remembered) return c.redirect(channelsPage(undefined, { error: 'expired' }));
  const { organisationId } = remembered;
  if (query.error || !query.code) return c.redirect(channelsPage(organisationId, { error: 'refused' }));
  try {
    const credentials = await exchangeTwitchCode(query.code);
    const broadcaster = await twitchBroadcaster(credentials);
    await transaction(() =>
      connectTwitchChannel(organisationId, {
        broadcasterId: broadcaster.id,
        login: broadcaster.login,
        displayName: broadcaster.displayName,
        credentials
      })
    );
  } catch (error) {
    console.error('Connecting a Twitch channel failed', error);
    return c.redirect(channelsPage(organisationId, { error: 'failed' }));
  }
  return c.redirect(channelsPage(organisationId, { connected: 'twitch' }));
}

export default new Hono().get('/twitch/callback', describeRoute({ hide: true }), requirePrincipal, twitchCallback);
