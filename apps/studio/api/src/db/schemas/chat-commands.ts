import { withAccess } from '@conservationtv/umbrella';
import { sql } from 'drizzle-orm';
import { boolean, check, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { CHAT_AUDIENCES, type ChatAudience } from '@conservationtv/chat';
import type { ChatCommandAction } from '../../chat/commands.ts';
import { organisations } from './organisations.ts';
import { topologyActions, topologyRoles } from './topology-access.ts';

/**
 * A command viewers use in the chat of the organisation's channels (src/chat/commands.ts): the word it is used by, who
 * may use it, how long it rests between uses, and the one thing it does. `triggeredAt` is when it last ran, which its
 * rest is counted from; only trusted code writes it, as an output's agent says the command was used.
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
      check(
        'chat_command_audience',
        sql.raw(`audience in (${CHAT_AUDIENCES.map(audience => `'${audience}'`).join(', ')})`)
      ),
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
