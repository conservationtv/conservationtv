import { eq, getColumnTable } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { ApiFailure } from '../errors.ts';
import { useDB } from '../db/transaction.ts';

// Topology reads and writes run as ordinary queries in the principal's request session: row-level security decides
// whose rows, and the composite foreign keys keep every reference inside one organisation. What the database refuses
// is reported by the error handler (src/middleware/errors.ts).

/** Why a write reached no row: the row is visible, so the principal may not change it, or it is not there for them. */
export async function unchanged(key: PgColumn, value: string) {
  const db = useDB();
  const rows = await db.select({ key }).from(getColumnTable(key)).where(eq(key, value)).limit(1);
  return new ApiFailure(rows.length > 0 ? 'forbidden' : 'not_found');
}
