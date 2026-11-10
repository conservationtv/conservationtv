import { withAccess } from '@conservationtv/umbrella';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid
} from 'drizzle-orm/pg-core';
import type { Settings } from '../../topology/settings.ts';
import { SHOW_RECORDER_KINDS, type ShowRecorderKind } from '../../topology/show-recorder-kinds.ts';
import { agents } from './agents.ts';
import { channels } from './channels.ts';
import { organisations } from './organisations.ts';
import { topologyActions, topologyRoles } from './topology-access.ts';

/**
 * A show going out (docs/show-topology.md): what its programme is encoded as, and through its output, forwards,
 * previews and recorders, where it goes. Every show follows its organisation's one broadcast for now (src/shows), so
 * what is on screen is the same for each; what goes out differs. The programme's encoding defaults to 1080p30 at
 * 6000 kbps with 2-second keyframes, Twitch's ceiling for unpartnered channels, and the size of MediaMTX's built-in
 * offline slate, which the programme's fallback plays when OBS is gone.
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
      width: integer('width').default(1920).notNull(),
      height: integer('height').default(1080).notNull(),
      fps: integer('fps').default(30).notNull(),
      bitrateKbps: integer('bitrate_kbps').default(6000).notNull(),
      keyframeSeconds: integer('keyframe_seconds').default(2).notNull(),
      createdAt: timestamp('created_at').defaultNow().notNull()
    },
    t => [unique('show_organisation_id').on(t.organisationId, t.id)]
  ),
  t => ({
    name: 'shows',
    scope: organisations.$access.scope.via(t.organisationId),
    immutable: [t.createdAt],
    actions: topologyActions,
    roles: topologyRoles
  })
);

/**
 * Where a show goes out: the agent that drives OBS for it, following the show and playing its streams
 * (apps/agent/core/src/runtimes/obs). A show has at most one output, and an agent is the output of at most one show,
 * since it runs one OBS.
 */
export const showOutputs = withAccess(
  pgTable(
    'show_output',
    {
      showId: uuid('show_id').primaryKey(),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      deviceId: uuid('device_id').notNull(),
      createdAt: timestamp('created_at').defaultNow().notNull()
    },
    t => [
      // The output is one of the organisation's shows', and goes with it.
      foreignKey({
        name: 'show_output_show_fk',
        columns: [t.organisationId, t.showId],
        foreignColumns: [shows.organisationId, shows.id]
      }).onDelete('cascade'),
      // The output is one of the organisation's agents, and goes with it.
      foreignKey({
        name: 'show_output_agent_fk',
        columns: [t.organisationId, t.deviceId],
        foreignColumns: [agents.organisationId, agents.id]
      }).onDelete('cascade'),
      uniqueIndex('show_output_device_idx').on(t.deviceId)
    ]
  ),
  t => ({
    name: 'showOutputs',
    scope: organisations.$access.scope.via(t.organisationId),
    immutable: [t.showId, t.organisationId, t.createdAt],
    actions: topologyActions,
    roles: topologyRoles
  })
);

/**
 * A channel a show's programme is forwarded to while it is `enabled`: a channel can be on for one show and off for
 * another. The output reads the channel's ingest when it forwards to it (`organisations.channels.ingest`).
 */
export const showForwards = withAccess(
  pgTable(
    'show_forward',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      showId: uuid('show_id').notNull(),
      channelId: uuid('channel_id').notNull(),
      enabled: boolean('enabled').default(true).notNull(),
      createdAt: timestamp('created_at').defaultNow().notNull()
    },
    t => [
      unique('show_forward_show_channel').on(t.showId, t.channelId),
      foreignKey({
        name: 'show_forward_show_fk',
        columns: [t.organisationId, t.showId],
        foreignColumns: [shows.organisationId, shows.id]
      }).onDelete('cascade'),
      foreignKey({
        name: 'show_forward_channel_fk',
        columns: [t.organisationId, t.channelId],
        foreignColumns: [channels.organisationId, channels.id]
      }).onDelete('cascade'),
      index('show_forward_channel_idx').on(t.channelId)
    ]
  ),
  t => ({
    name: 'showForwards',
    scope: organisations.$access.scope.via(t.organisationId),
    immutable: [t.showId, t.channelId, t.createdAt],
    actions: topologyActions,
    roles: topologyRoles
  })
);

/**
 * A place a show's programme is published to and read from, as an exposure is a stream's: a gateway, built in or the
 * organisation's own, which decides where it can be read and by which protocols. The programme is one encoding, so a
 * preview offers the one `default` rendition.
 */
export const showPreviews = withAccess(
  pgTable(
    'show_preview',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      showId: uuid('show_id').notNull(),
      // A built-in gateway's slug or one of the organisation's gateways (src/topology/exposures.ts checks which).
      gatewayId: text('gateway_id').notNull(),
      createdAt: timestamp('created_at').defaultNow().notNull()
    },
    t => [
      unique('show_preview_show_gateway').on(t.showId, t.gatewayId),
      foreignKey({
        name: 'show_preview_show_fk',
        columns: [t.organisationId, t.showId],
        foreignColumns: [shows.organisationId, shows.id]
      }).onDelete('cascade'),
      index('show_preview_gateway_idx').on(t.gatewayId)
    ]
  ),
  t => ({
    name: 'showPreviews',
    scope: organisations.$access.scope.via(t.organisationId),
    immutable: [t.showId, t.gatewayId, t.createdAt],
    actions: topologyActions,
    roles: topologyRoles
  })
);

/**
 * A recording of a show's programme, made by its output alongside streaming it: `obs`, OBS's own recording. One of
 * each kind per show, as OBS records one file at a time.
 */
export const showRecorders = withAccess(
  pgTable(
    'show_recorder',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      showId: uuid('show_id').notNull(),
      kind: text('kind').$type<ShowRecorderKind>().notNull(),
      params: jsonb('params').$type<Settings>().default({}).notNull(),
      createdAt: timestamp('created_at').defaultNow().notNull()
    },
    t => [
      unique('show_recorder_show_kind').on(t.showId, t.kind),
      check('show_recorder_kind', sql.raw(`kind in (${SHOW_RECORDER_KINDS.map(kind => `'${kind}'`).join(', ')})`)),
      foreignKey({
        name: 'show_recorder_show_fk',
        columns: [t.organisationId, t.showId],
        foreignColumns: [shows.organisationId, shows.id]
      }).onDelete('cascade')
    ]
  ),
  t => ({
    name: 'showRecorders',
    scope: organisations.$access.scope.via(t.organisationId),
    immutable: [t.showId, t.createdAt],
    actions: topologyActions,
    roles: topologyRoles
  })
);
