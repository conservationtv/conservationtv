import { withAccess } from '@conservationtv/umbrella';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid
} from 'drizzle-orm/pg-core';
import { organisationAdmin, organisationMember } from '../roles.ts';
import { organisations } from './organisations.ts';
import { streams } from './streams.ts';
import { topologyActions, topologyRoles } from './topology-access.ts';

/**
 * A show (docs/shows.md): what is on screen, and the few attributes it is operated by. `slots` is its layout, from none
 * to six (packages/shows); `volume_db` and `muted` its own mix; `takeover_stream_id` arms a stream to take over the
 * screen, and `takeover_live` puts it on air, never without one armed. Its object (src/shows/host.tsx, keyed by the
 * show's ID) composes it from these and its streams (`show_stream`), and is followed by the outputs that send it out
 * (`output.show_id`, src/db/schemas/outputs.ts). It says nothing of how it goes out: an output's encoding, forwards,
 * previews and recorders are the output's.
 *
 * Any member operates a show: `operate` is the one update, of everything but its name. Administrators alone create,
 * name and delete one. The name is immutable to every request session, so a rename is trusted code that first asks
 * umbrella whether the caller may `create` shows (renameShow, src/services/shows.ts): umbrella grants columns to the
 * application role, not to a principal, so a member's update cannot be kept off one column any other way.
 *
 * A takeover stream is cleared before its stream is deleted (src/services/streams.ts): its foreign key cannot do it,
 * as setting both its columns null would clear `organisation_id`.
 */
export const shows = withAccess(
  pgTable(
    'show',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      name: text('name').notNull(),
      slots: integer('slots').default(6).notNull(),
      volumeDb: doublePrecision('volume_db').default(0).notNull(),
      muted: boolean('muted').default(false).notNull(),
      takeoverStreamId: uuid('takeover_stream_id'),
      takeoverLive: boolean('takeover_live').default(false).notNull(),
      createdAt: timestamp('created_at').defaultNow().notNull()
    },
    t => [
      unique('show_organisation_id').on(t.organisationId, t.id),
      check('show_slots', sql`${t.slots} between 0 and 6`),
      // A takeover is on air only while a stream is armed for it.
      check('show_takeover_live', sql`${t.takeoverStreamId} is not null or not ${t.takeoverLive}`),
      foreignKey({
        name: 'show_takeover_stream_fk',
        columns: [t.organisationId, t.takeoverStreamId],
        foreignColumns: [streams.organisationId, streams.id]
      }),
      index('show_takeover_stream_idx').on(t.takeoverStreamId)
    ]
  ),
  t => ({
    name: 'shows',
    scope: organisations.$access.scope.via(t.organisationId),
    immutable: [t.name, t.createdAt],
    actions: { read: ['select'], create: ['insert'], operate: ['update'], remove: ['delete'] },
    roles: {
      member: {
        label: 'Operator',
        permissions: ['read', 'operate'],
        assignableScopes: ['organisation'],
        includedIn: [organisationMember]
      },
      admin: {
        label: 'Administrator',
        permissions: ['read', 'create', 'operate', 'remove'],
        assignableScopes: ['organisation'],
        includedIn: [organisationAdmin]
      }
    }
  })
);

/**
 * One stream's membership of one show: its place in the lineup (`rank`, none while it is out of it), and its channel
 * in the show's mix: its level, whether it is muted, how far its sound is shifted, and whose sound it brings
 * (`audio_stream_id`, null for its own). Made the first time something needs it (a sync placing a camera in the
 * lineup, or someone setting its sound), and gone with its show or its stream; the sound settings outlive the stream's
 * time on screen. Positions are never stored: the lineup is the show's streams in rank order (src/shows/resolve.ts).
 *
 * Members read and write it, as they operate the show. An audio stream is cleared before its stream is deleted
 * (src/services/streams.ts), as a takeover stream is.
 */
export const showStreams = withAccess(
  pgTable(
    'show_stream',
    {
      showId: uuid('show_id').notNull(),
      streamId: uuid('stream_id').notNull(),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      rank: integer('rank'),
      volumeDb: doublePrecision('volume_db').default(0).notNull(),
      muted: boolean('muted').default(false).notNull(),
      syncOffsetMs: integer('sync_offset_ms').default(0).notNull(),
      audioStreamId: uuid('audio_stream_id')
    },
    t => [
      primaryKey({ name: 'show_stream_pk', columns: [t.showId, t.streamId] }),
      foreignKey({
        name: 'show_stream_show_fk',
        columns: [t.organisationId, t.showId],
        foreignColumns: [shows.organisationId, shows.id]
      }).onDelete('cascade'),
      foreignKey({
        name: 'show_stream_stream_fk',
        columns: [t.organisationId, t.streamId],
        foreignColumns: [streams.organisationId, streams.id]
      }).onDelete('cascade'),
      foreignKey({
        name: 'show_stream_audio_stream_fk',
        columns: [t.organisationId, t.audioStreamId],
        foreignColumns: [streams.organisationId, streams.id]
      }),
      index('show_stream_stream_idx').on(t.streamId),
      index('show_stream_audio_stream_idx').on(t.audioStreamId),
      index('show_stream_organisation_idx').on(t.organisationId)
    ]
  ),
  t => ({
    name: 'showStreams',
    scope: organisations.$access.scope.via(t.organisationId),
    immutable: [t.showId, t.streamId],
    actions: topologyActions,
    roles: {
      member: {
        label: 'Operator',
        permissions: ['read', 'create', 'edit'],
        assignableScopes: ['organisation'],
        includedIn: [organisationMember]
      },
      admin: topologyRoles.admin
    }
  })
);
