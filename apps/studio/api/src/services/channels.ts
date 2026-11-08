import { and, eq } from 'drizzle-orm';
import type { ChannelCredentials, RtmpCredentials, TwitchCredentials } from '../channels/kinds.ts';
import { channelCredentials, channels } from '../db/schema.ts';
import { useDB } from '../db/transaction.ts';
import { unchanged } from '../topology/transaction.ts';

// Where an organisation's broadcast goes out to (src/db/schemas/channels.ts), all in the principal's request session:
// members see the channels, administrators connect and manage them, and their credentials (`channel_credential`) are
// read and refreshed only by `channelBroadcaster`, which administrators hold and the show's output agent is granted.
// No trusted code reads a stream key: row-level security decides who does.

/** What is listed of a channel. Its credentials are in a table of their own. */
const listed = {
  id: channels.id,
  kind: channels.kind,
  name: channels.name,
  externalId: channels.externalId,
  externalLogin: channels.externalLogin,
  enabled: channels.enabled,
  createdAt: channels.createdAt
};

export interface NewRtmpChannel {
  name: string;
  url: string;
  key: string;
}

export interface ChannelChanges {
  name?: string;
  enabled?: boolean;
}

export interface TwitchConnection {
  broadcasterId: string;
  login: string;
  displayName: string;
  credentials: TwitchCredentials;
}

/** The organisation's channels, oldest first. */
export function listChannels(organisationId: string) {
  const db = useDB();
  return db.select(listed).from(channels).where(eq(channels.organisationId, organisationId)).orderBy(channels.id);
}

/** Add an RTMP(S) destination entered by hand. */
export async function createRtmpChannel(organisationId: string, payload: NewRtmpChannel) {
  const db = useDB();
  const credentials: RtmpCredentials = { kind: 'rtmp', url: payload.url, key: payload.key };
  const [row] = await db
    .insert(channels)
    .values({ organisationId, kind: 'rtmp', name: payload.name })
    .returning(listed);
  await db.insert(channelCredentials).values({ channelId: row!.id, organisationId, credentials });
  return row!;
}

/** Add the Twitch channel, or refresh its tokens if it is connected already. */
export async function connectTwitchChannel(organisationId: string, connection: TwitchConnection) {
  const db = useDB();
  const [row] = await db
    .insert(channels)
    .values({
      organisationId,
      kind: 'twitch',
      name: connection.displayName,
      externalId: connection.broadcasterId,
      externalLogin: connection.login
    })
    .onConflictDoUpdate({
      target: [channels.organisationId, channels.kind, channels.externalId],
      set: { externalLogin: connection.login }
    })
    .returning(listed);
  const { credentials } = connection;
  await db
    .insert(channelCredentials)
    .values({ channelId: row!.id, organisationId, credentials })
    .onConflictDoUpdate({ target: channelCredentials.channelId, set: { credentials, updatedAt: new Date() } });
  return row!;
}

/** Rename the channel or turn it on or off: `forbidden` or `not_found` when the write reaches no row. */
export async function updateChannel(organisationId: string, channelId: string, changes: ChannelChanges) {
  const db = useDB();
  const [row] = await db
    .update(channels)
    .set({ name: changes.name, enabled: changes.enabled })
    .where(and(eq(channels.organisationId, organisationId), eq(channels.id, channelId)))
    .returning(listed);
  if (!row) throw await unchanged(channels.id, channelId);
  return row;
}

/** Disconnect the channel: `forbidden` or `not_found` when the write reaches no row. */
export async function deleteChannel(organisationId: string, channelId: string) {
  const db = useDB();
  const deleted = await db
    .delete(channels)
    .where(and(eq(channels.organisationId, organisationId), eq(channels.id, channelId)))
    .returning({ id: channels.id });
  if (deleted.length === 0) throw await unchanged(channels.id, channelId);
}

/** The organisation's enabled channels: what its broadcast forwards to. Trusted code, for planning: IDs only. */
export function selectEnabledChannels(organisationId: string) {
  const db = useDB({ trusted: true });
  return db
    .select({ id: channels.id })
    .from(channels)
    .where(and(eq(channels.organisationId, organisationId), eq(channels.enabled, true)))
    .orderBy(channels.id);
}

/** The channel with its credentials, if the principal is one of the organisation's broadcasters. */
export async function getChannelCredentials(organisationId: string, channelId: string) {
  const db = useDB();
  const [row] = await db
    .select({ id: channels.id, externalId: channels.externalId, credentials: channelCredentials.credentials })
    .from(channels)
    .innerJoin(channelCredentials, eq(channelCredentials.channelId, channels.id))
    .where(and(eq(channels.organisationId, organisationId), eq(channels.id, channelId)));
  return row;
}

/** Keep refreshed credentials, as one of the organisation's broadcasters. */
export async function saveChannelCredentials(
  organisationId: string,
  channelId: string,
  credentials: ChannelCredentials
) {
  const db = useDB();
  const saved = await db
    .update(channelCredentials)
    .set({ credentials, updatedAt: new Date() })
    .where(and(eq(channelCredentials.organisationId, organisationId), eq(channelCredentials.channelId, channelId)))
    .returning({ channelId: channelCredentials.channelId });
  if (saved.length === 0) throw await unchanged(channelCredentials.channelId, channelId);
}
