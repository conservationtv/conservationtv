import { withAccess } from '@conservationtv/umbrella';
import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { CHANNEL_KINDS, ChannelCredentialsSchema, type ChannelKind } from '../../channels/kinds.ts';
import { encrypted, json } from '../encrypted.ts';
import { channelBroadcaster, organisationAdmin } from '../roles.ts';
import { organisations } from './organisations.ts';
import { topologyActions, topologyRoles } from './topology-access.ts';

/**
 * Somewhere an organisation's shows go out to, such as a Twitch channel (src/channels). A show's output agent forwards
 * its programme to each channel the show has an enabled forward to (`show_forward`, apps/agent/core/src/runtimes/obs).
 * What reaches it, its stream key or OAuth tokens, is kept apart in `channel_credential`, under a role of its own.
 */
export const channels = withAccess(
  pgTable(
    'channel',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      kind: text('kind').$type<ChannelKind>().notNull(),
      name: text('name').notNull(),
      /** The account on the other side, such as the Twitch broadcaster's ID and login; null for a plain RTMP URL. */
      externalId: text('external_id'),
      externalLogin: text('external_login'),
      /**
       * Unused: whether a show goes out to it is now each show's forward (`show_forward.enabled`). Kept for one release,
       * because migrations run before the new API version is uploaded and the version still serving reads it; drop it
       * in a migration of its own once this version serves everywhere.
       */
      enabled: boolean('enabled').default(true).notNull(),
      createdAt: timestamp('created_at').defaultNow().notNull()
    },
    t => [
      unique('channel_organisation_id').on(t.organisationId, t.id),
      // One connection per account per organisation: connecting it again refreshes it.
      unique('channel_organisation_external').on(t.organisationId, t.kind, t.externalId),
      check('channel_kind', sql.raw(`kind in (${CHANNEL_KINDS.map(kind => `'${kind}'`).join(', ')})`)),
      index('channel_organisation_idx').on(t.organisationId)
    ]
  ),
  t => ({
    name: 'channels',
    scope: organisations.$access.scope.via(t.organisationId),
    immutable: [t.kind, t.createdAt],
    actions: topologyActions,
    roles: {
      ...topologyRoles,
      // The output agent reads which channels there are, to ask for their ingests.
      broadcaster: {
        label: 'Broadcaster',
        permissions: ['read'],
        assignableScopes: ['organisation'],
        includedIn: [channelBroadcaster]
      }
    }
  })
);

/**
 * What reaches a channel: an RTMP URL and stream key, or a Twitch connection's OAuth tokens, encrypted. Members, who
 * read the channels, never read these: only `channelBroadcaster` does, which administrators hold and each show's output
 * agent is granted. Administrators write them when they add or connect a channel; the agent keeps refreshed tokens.
 */
export const channelCredentials = withAccess(
  pgTable(
    'channel_credential',
    {
      channelId: uuid('channel_id').primaryKey(),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      credentials: encrypted('channel.credentials', json(ChannelCredentialsSchema))('credentials').notNull(),
      updatedAt: timestamp('updated_at').defaultNow().notNull()
    },
    t => [
      // The channel's, in its organisation, and gone with it.
      foreignKey({
        name: 'channel_credential_channel_fk',
        columns: [t.organisationId, t.channelId],
        foreignColumns: [channels.organisationId, channels.id]
      }).onDelete('cascade'),
      index('channel_credential_organisation_idx').on(t.organisationId)
    ]
  ),
  t => ({
    name: 'channelCredentials',
    scope: organisations.$access.scope.via(t.organisationId),
    actions: { read: ['select'], create: ['insert'], edit: ['update'], remove: ['delete'] },
    roles: {
      broadcaster: {
        label: 'Broadcaster',
        permissions: ['read', 'edit'],
        assignableScopes: ['organisation'],
        includedIn: [channelBroadcaster]
      },
      admin: {
        label: 'Administrator',
        permissions: ['read', 'create', 'edit', 'remove'],
        assignableScopes: ['organisation'],
        includedIn: [organisationAdmin]
      }
    }
  })
);
