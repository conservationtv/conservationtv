import { withAccess } from '@conservationtv/umbrella';
import { sql } from 'drizzle-orm';
import { check, foreignKey, index, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { encrypted, Utf8Schema } from '../encrypted.ts';
import { organisationAdmin, organisationMember, streamPublisher } from '../roles.ts';
import { organisationMemberships, organisations } from './organisations.ts';
import { PERSONAL_DEVICES, type PersonalDevice } from '../../topology/personal-devices.ts';
import { streams } from './streams.ts';

// Going live (docs/shows.md): what a pushed stream, one with no source device, is published with. Its exposures are
// plumbing the API makes when someone publishes (src/gateways/publish.ts); what is kept here is what lasts.

/**
 * The key an encoder that only takes a URL (OBS, a phone's streaming app) publishes a pushed stream with: one per
 * stream, replaceable, encrypted at rest. Members, who read the streams, never read it: only `streamPublisher` does,
 * which administrators hold. No device reads it either. The agent whose MediaMTX admits the encoder is told
 * `key_sha256` alone in its configuration (src/configuration/plan), which admits nothing: the key is 32 random bytes,
 * so its digest cannot be turned back into it.
 */
export const streamKeys = withAccess(
  pgTable(
    'stream_key',
    {
      streamId: uuid('stream_id').primaryKey(),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      key: encrypted('stream.key', Utf8Schema)('key').notNull(),
      keySha256: text('key_sha256').notNull(),
      createdAt: timestamp('created_at').defaultNow().notNull()
    },
    t => [
      // The stream's, in its organisation, and gone with it.
      foreignKey({
        name: 'stream_key_stream_fk',
        columns: [t.organisationId, t.streamId],
        foreignColumns: [streams.organisationId, streams.id]
      }).onDelete('cascade'),
      check('stream_key_sha256_hex', sql`${t.keySha256} ~ '^[0-9a-f]{64}$'`),
      index('stream_key_organisation_idx').on(t.organisationId)
    ]
  ),
  t => ({
    name: 'streamKeys',
    scope: organisations.$access.scope.via(t.organisationId),
    actions: { read: ['select'], create: ['insert'], edit: ['update'], remove: ['delete'] },
    roles: {
      publisher: {
        label: 'Publisher',
        permissions: ['read', 'create', 'edit', 'remove'],
        assignableScopes: ['organisation'],
        includedIn: [streamPublisher]
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

/**
 * The stream a member goes live on from the studio, by the kind of device they go live from ("James's phone"): made
 * the first time they do, and reused after, so a show that knows it keeps knowing it. Written by trusted code only
 * (src/services/publishing.ts), once the member may publish; members read it. Gone with the stream, or the membership:
 * the stream itself stays, as the organisation's.
 */
export const personalStreams = withAccess(
  pgTable(
    'personal_stream',
    {
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      userId: text('user_id').notNull(),
      device: text('device').$type<PersonalDevice>().notNull(),
      streamId: uuid('stream_id').notNull(),
      createdAt: timestamp('created_at').defaultNow().notNull()
    },
    t => [
      primaryKey({ columns: [t.organisationId, t.userId, t.device] }),
      unique('personal_stream_stream').on(t.streamId),
      check('personal_stream_device', sql.raw(`device in (${PERSONAL_DEVICES.map(kind => `'${kind}'`).join(', ')})`)),
      foreignKey({
        name: 'personal_stream_stream_fk',
        columns: [t.organisationId, t.streamId],
        foreignColumns: [streams.organisationId, streams.id]
      }).onDelete('cascade'),
      foreignKey({
        name: 'personal_stream_membership_fk',
        columns: [t.organisationId, t.userId],
        foreignColumns: [organisationMemberships.organisationId, organisationMemberships.userId]
      }).onDelete('cascade'),
      index('personal_stream_user_idx').on(t.userId)
    ]
  ),
  t => ({
    name: 'personalStreams',
    scope: organisations.$access.scope.via(t.organisationId),
    actions: { read: ['select'] },
    roles: {
      member: {
        label: 'Member',
        permissions: ['read'],
        assignableScopes: ['organisation'],
        includedIn: [organisationMember]
      }
    }
  })
);
