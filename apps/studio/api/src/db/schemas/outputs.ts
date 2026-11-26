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
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid
} from 'drizzle-orm/pg-core';
import {
  OUTPUT_CONTROLS,
  OUTPUT_RECORDER_KINDS,
  type OutputControl,
  type OutputRecorderKind
} from '../../topology/output-recorder-kinds.ts';
import type { Settings } from '../../topology/settings.ts';
import { encrypted, Utf8Schema } from '../encrypted.ts';
import { organisationAdmin } from '../roles.ts';
import { agents } from './agents.ts';
import { channels } from './channels.ts';
import { organisations } from './organisations.ts';
import { shows } from './shows.ts';
import { topologyActions, topologyRoles } from './topology-access.ts';

/** `kind in ('a', 'b')`, for a check constraint on a closed vocabulary. */
const oneOf = (column: string, values: readonly string[]) =>
  sql.raw(`${column} in (${values.map(value => `'${value}'`).join(', ')})`);

/**
 * Something going out (docs/outputs.md): one OBS, on its agent (`output_device`), streaming a programme encoded as
 * this says, with the programme MediaMTX behind it that forwards, previews and records it. Who drives OBS's scenes is
 * its `control`: `show`, the show it follows (`show_id`, none to follow nothing yet), or `external`, something outside
 * the studio, for which the output reads any of its organisation's exposures (src/gateways/connect.ts). An external
 * output follows no show. Its `input_gateway_id`, when set, is the one gateway (built in, or the organisation's own) it
 * reads every stream from, whatever else delivers them; none lets each stream's read choose (src/gateways/connect.ts).
 * The programme's encoding defaults to 1080p30 at 6000 kbps with 2-second keyframes, Twitch's
 * ceiling for unpartnered channels, and the size of MediaMTX's built-in offline slate, which the programme's fallback
 * plays when OBS is gone.
 *
 * Deleting a show leaves its outputs following nothing (src/services/shows.ts); `show_id`'s foreign key cannot do it,
 * as setting both its columns null would clear `organisation_id`.
 */
export const outputs = withAccess(
  pgTable(
    'output',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      name: text('name').notNull(),
      control: text('control').$type<OutputControl>().default('show').notNull(),
      showId: uuid('show_id'),
      // A built-in gateway's slug or one of the organisation's gateways, as an exposure's is.
      inputGatewayId: text('input_gateway_id'),
      width: integer('width').default(1920).notNull(),
      height: integer('height').default(1080).notNull(),
      fps: integer('fps').default(30).notNull(),
      bitrateKbps: integer('bitrate_kbps').default(6000).notNull(),
      keyframeSeconds: integer('keyframe_seconds').default(2).notNull(),
      createdAt: timestamp('created_at').defaultNow().notNull()
    },
    t => [
      unique('output_organisation_id').on(t.organisationId, t.id),
      check('output_control', oneOf('control', OUTPUT_CONTROLS)),
      // An externally controlled output follows no show.
      check('output_external_show', sql`${t.control} = 'show' or ${t.showId} is null`),
      foreignKey({
        name: 'output_show_fk',
        columns: [t.organisationId, t.showId],
        foreignColumns: [shows.organisationId, shows.id]
      }),
      index('output_show_idx').on(t.showId)
    ]
  ),
  t => ({
    name: 'outputs',
    scope: organisations.$access.scope.via(t.organisationId),
    immutable: [t.createdAt],
    actions: topologyActions,
    roles: topologyRoles
  })
);

/**
 * The agent an output runs on, driving its OBS. An output has at most one, and an agent is the device of at most one
 * output, since it runs one OBS.
 */
export const outputDevices = withAccess(
  pgTable(
    'output_device',
    {
      outputId: uuid('output_id').primaryKey(),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      deviceId: uuid('device_id').notNull(),
      createdAt: timestamp('created_at').defaultNow().notNull()
    },
    t => [
      // One of the organisation's outputs, and gone with it.
      foreignKey({
        name: 'output_device_output_fk',
        columns: [t.organisationId, t.outputId],
        foreignColumns: [outputs.organisationId, outputs.id]
      }).onDelete('cascade'),
      // One of the organisation's agents, and gone with it.
      foreignKey({
        name: 'output_device_agent_fk',
        columns: [t.organisationId, t.deviceId],
        foreignColumns: [agents.organisationId, agents.id]
      }).onDelete('cascade'),
      uniqueIndex('output_device_device_idx').on(t.deviceId)
    ]
  ),
  t => ({
    name: 'outputDevices',
    scope: organisations.$access.scope.via(t.organisationId),
    immutable: [t.outputId, t.organisationId, t.createdAt],
    actions: topologyActions,
    roles: topologyRoles
  })
);

/**
 * A channel whose chat controls an output's broadcast, whether or not the output goes out to it: the output's agent
 * listens to its chat for commands, as it does to the Twitch channels it forwards to, and this API takes a use heard
 * there as one of the output's (src/routes/chat-uses.ts). A Twitch channel alone, since only Twitch chat is listened
 * to.
 */
export const outputControlChannels = withAccess(
  pgTable(
    'output_control_channel',
    {
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      outputId: uuid('output_id').notNull(),
      channelId: uuid('channel_id').notNull(),
      createdAt: timestamp('created_at').defaultNow().notNull()
    },
    t => [
      primaryKey({ name: 'output_control_channel_pkey', columns: [t.outputId, t.channelId] }),
      foreignKey({
        name: 'output_control_channel_output_fk',
        columns: [t.organisationId, t.outputId],
        foreignColumns: [outputs.organisationId, outputs.id]
      }).onDelete('cascade'),
      foreignKey({
        name: 'output_control_channel_channel_fk',
        columns: [t.organisationId, t.channelId],
        foreignColumns: [channels.organisationId, channels.id]
      }).onDelete('cascade'),
      index('output_control_channel_channel_idx').on(t.channelId)
    ]
  ),
  t => ({
    name: 'outputControlChannels',
    scope: organisations.$access.scope.via(t.organisationId),
    immutable: [t.outputId, t.channelId, t.createdAt],
    actions: topologyActions,
    roles: topologyRoles
  })
);

/**
 * A channel an output's programme is forwarded to while it is `enabled`: a channel can be on for one output and off for
 * another. The output's agent reads the channel's ingest when it forwards to it (`organisations.channels.ingest`).
 */
export const outputForwards = withAccess(
  pgTable(
    'output_forward',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      outputId: uuid('output_id').notNull(),
      channelId: uuid('channel_id').notNull(),
      enabled: boolean('enabled').default(true).notNull(),
      createdAt: timestamp('created_at').defaultNow().notNull()
    },
    t => [
      unique('output_forward_output_channel').on(t.outputId, t.channelId),
      foreignKey({
        name: 'output_forward_output_fk',
        columns: [t.organisationId, t.outputId],
        foreignColumns: [outputs.organisationId, outputs.id]
      }).onDelete('cascade'),
      foreignKey({
        name: 'output_forward_channel_fk',
        columns: [t.organisationId, t.channelId],
        foreignColumns: [channels.organisationId, channels.id]
      }).onDelete('cascade'),
      index('output_forward_channel_idx').on(t.channelId)
    ]
  ),
  t => ({
    name: 'outputForwards',
    scope: organisations.$access.scope.via(t.organisationId),
    immutable: [t.outputId, t.channelId, t.createdAt],
    actions: topologyActions,
    roles: topologyRoles
  })
);

/**
 * A place an output's programme is published to and read from, as an exposure is a stream's: a gateway, built in or the
 * organisation's own, which decides where it can be read and by which protocols. The programme is one encoding, so a
 * preview carries that one picture.
 */
export const outputPreviews = withAccess(
  pgTable(
    'output_preview',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      outputId: uuid('output_id').notNull(),
      // A built-in gateway's slug or one of the organisation's gateways (src/topology/exposures.ts checks which).
      gatewayId: text('gateway_id').notNull(),
      createdAt: timestamp('created_at').defaultNow().notNull()
    },
    t => [
      unique('output_preview_output_gateway').on(t.outputId, t.gatewayId),
      foreignKey({
        name: 'output_preview_output_fk',
        columns: [t.organisationId, t.outputId],
        foreignColumns: [outputs.organisationId, outputs.id]
      }).onDelete('cascade'),
      index('output_preview_gateway_idx').on(t.gatewayId)
    ]
  ),
  t => ({
    name: 'outputPreviews',
    scope: organisations.$access.scope.via(t.organisationId),
    immutable: [t.outputId, t.gatewayId, t.createdAt],
    actions: topologyActions,
    roles: topologyRoles
  })
);

/**
 * A recording of an output's programme, made by its agent alongside streaming it: `obs`, OBS's own recording. One of
 * each kind per output, as OBS records one file at a time.
 */
export const outputRecorders = withAccess(
  pgTable(
    'output_recorder',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      outputId: uuid('output_id').notNull(),
      kind: text('kind').$type<OutputRecorderKind>().notNull(),
      params: jsonb('params').$type<Settings>().default({}).notNull(),
      createdAt: timestamp('created_at').defaultNow().notNull()
    },
    t => [
      unique('output_recorder_output_kind').on(t.outputId, t.kind),
      check('output_recorder_kind', oneOf('kind', OUTPUT_RECORDER_KINDS)),
      foreignKey({
        name: 'output_recorder_output_fk',
        columns: [t.organisationId, t.outputId],
        foreignColumns: [outputs.organisationId, outputs.id]
      }).onDelete('cascade')
    ]
  ),
  t => ({
    name: 'outputRecorders',
    scope: organisations.$access.scope.via(t.organisationId),
    immutable: [t.outputId, t.createdAt],
    actions: topologyActions,
    roles: topologyRoles
  })
);

/**
 * How to drive an output's OBS from outside, as its agent last reported it (`organisations.outputs.control.report`):
 * obs-websocket's port and password, the scene collection OBS runs, and the address OBS reads each of the
 * organisation's exposures at, on its own machine. The password is encrypted, and only administrators read any of it:
 * it lets whoever holds it change what goes out. Written by trusted code, for the output's device only.
 */
export const outputControls = withAccess(
  pgTable(
    'output_control',
    {
      outputId: uuid('output_id').primaryKey(),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      deviceId: uuid('device_id').notNull(),
      websocketPort: integer('websocket_port').notNull(),
      websocketPassword: encrypted('output.websocket_password', Utf8Schema)('websocket_password').notNull(),
      sceneCollection: text('scene_collection').notNull(),
      inputUrl: text('input_url').notNull(),
      reportedAt: timestamp('reported_at').defaultNow().notNull()
    },
    t => [
      foreignKey({
        name: 'output_control_output_fk',
        columns: [t.organisationId, t.outputId],
        foreignColumns: [outputs.organisationId, outputs.id]
      }).onDelete('cascade'),
      index('output_control_organisation_idx').on(t.organisationId)
    ]
  ),
  t => ({
    name: 'outputControls',
    scope: organisations.$access.scope.via(t.organisationId),
    actions: { read: ['select'] },
    roles: {
      admin: {
        label: 'Administrator',
        permissions: ['read'],
        assignableScopes: ['organisation'],
        includedIn: [organisationAdmin]
      }
    }
  })
);
