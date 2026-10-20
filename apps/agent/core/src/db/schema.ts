import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// The agent's own state, kept on its machine. Live status is never stored: it is rebuilt from the runtimes.

/** Converge's spec as the sink last saved it: one row, the whole spec as JSON. */
export const convergeSpec = sqliteTable(
  'converge_spec',
  {
    id: integer('id').primaryKey(),
    spec: text('spec').notNull(),
    /** ISO 8601. */
    savedAt: text('saved_at').notNull()
  },
  table => [check('converge_spec_single_row', sql`${table.id} = 1`)]
);
