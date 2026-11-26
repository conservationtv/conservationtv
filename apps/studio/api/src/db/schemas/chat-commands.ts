import { withAccess } from '@conservationtv/umbrella';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid
} from 'drizzle-orm/pg-core';
import {
  CHAT_AUDIENCES,
  STANDARD_COMMAND_NAMES,
  type ChatAudience,
  type StandardCommandName
} from '@conservationtv/chat';
import type { ChatCommandAction } from '../../chat/commands.ts';
import { organisations } from './organisations.ts';
import { observationAccess } from './report-access.ts';
import { topologyActions, topologyRoles } from './topology-access.ts';

/** `column in ('a', 'b')`, for a check constraint on a closed vocabulary. */
const oneOf = (column: string, values: readonly string[]) =>
  sql.raw(`${column} in (${values.map(value => `'${value}'`).join(', ')})`);

/**
 * A command of the organisation's own, which viewers use in the chat of its channels (src/chat/commands.ts): the word
 * it is used by, who may use it, how long it rests between uses, and what it says. The standard commands, for cameras,
 * the layout and the mix, are everyone's (`@conservationtv/chat`), so none of these is used by one of their words.
 * `triggeredAt` is when it last ran, which its rest is counted from; only trusted code writes it, as an output's agent
 * says the command was used.
 */
export const chatCommands = withAccess(
  pgTable(
    'chat_command',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      name: text('name').notNull(),
      action: jsonb('action').$type<ChatCommandAction>().notNull(),
      audience: text('audience').$type<ChatAudience>().default('moderator').notNull(),
      cooldownSeconds: integer('cooldown_seconds').default(5).notNull(),
      enabled: boolean('enabled').default(true).notNull(),
      triggeredAt: timestamp('triggered_at'),
      createdAt: timestamp('created_at').defaultNow().notNull()
    },
    t => [
      // One command per word in an organisation.
      unique('chat_command_organisation_name').on(t.organisationId, t.name),
      check('chat_command_audience', oneOf('audience', CHAT_AUDIENCES)),
      check('chat_command_cooldown', sql`${t.cooldownSeconds} >= 0`)
    ]
  ),
  t => ({
    name: 'chatCommands',
    scope: organisations.$access.scope.via(t.organisationId),
    immutable: [t.triggeredAt, t.createdAt],
    actions: topologyActions,
    roles: topologyRoles
  })
);

/**
 * How an organisation has changed one of the standard commands (`@conservationtv/chat`): whether it is on, who may use
 * it and how long it rests. A command with no row is as the catalogue has it, so a standard command added later reaches
 * every organisation as it is, with nothing to backfill.
 */
export const chatCommandSettings = withAccess(
  pgTable(
    'chat_command_setting',
    {
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      command: text('command').$type<StandardCommandName>().notNull(),
      enabled: boolean('enabled').notNull(),
      audience: text('audience').$type<ChatAudience>().notNull(),
      cooldownSeconds: integer('cooldown_seconds').notNull(),
      updatedAt: timestamp('updated_at').defaultNow().notNull()
    },
    t => [
      primaryKey({ name: 'chat_command_setting_pkey', columns: [t.organisationId, t.command] }),
      check('chat_command_setting_command', oneOf('command', STANDARD_COMMAND_NAMES)),
      check('chat_command_setting_audience', oneOf('audience', CHAT_AUDIENCES)),
      check('chat_command_setting_cooldown', sql`${t.cooldownSeconds} >= 0`)
    ]
  ),
  t => ({
    name: 'chatCommandSettings',
    scope: organisations.$access.scope.via(t.organisationId),
    immutable: [t.organisationId, t.command],
    actions: topologyActions,
    roles: topologyRoles
  })
);

/**
 * When a standard command last ran on one target, which its rest there is counted from: a camera, for a camera
 * command, or a show, for a layout or audio command (`target` in `@conservationtv/chat`). Neither is a reference: a
 * turn outlives what it was taken on only as long as it matters, its cooldown. Only trusted code writes it, as an
 * output's agent says the command was used; members read it.
 */
export const chatCommandTurns = withAccess(
  pgTable(
    'chat_command_turn',
    {
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      command: text('command').$type<StandardCommandName>().notNull(),
      targetId: uuid('target_id').notNull(),
      triggeredAt: timestamp('triggered_at')
    },
    t => [primaryKey({ name: 'chat_command_turn_pkey', columns: [t.organisationId, t.command, t.targetId] })]
  ),
  t => ({
    name: 'chatCommandTurns',
    scope: organisations.$access.scope.via(t.organisationId),
    ...observationAccess
  })
);
