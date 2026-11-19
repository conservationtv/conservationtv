import { withAccess } from '@conservationtv/umbrella';
import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { organisations } from './organisations.ts';
import { topologyActions, topologyRoles } from './topology-access.ts';

/**
 * A show: what is on screen, composed by its object (src/shows/host.tsx, keyed by the show's ID) from what its commands
 * set, and followed by the outputs that send it out (`output.show_id`, src/db/schemas/outputs.ts). It says nothing of
 * how it goes out: an output's encoding, forwards, previews and recorders are the output's.
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
