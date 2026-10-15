import { eq, getColumnTable } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { subjects } from '../db/schema.ts';
import { ApiFailure } from '../errors.ts';
import type { Transaction } from '../organisations/membership.ts';

// Topology reads and writes run as ordinary queries in the principal's request session: row-level security decides
// whose rows, and the composite foreign keys keep every reference inside one organisation. What the database refuses
// is reported by the error handler (src/middleware/errors.ts).

/** Why a write reached no row: the row is visible, so the principal may not change it, or it is not there for them. */
export async function unchanged(tx: Transaction, key: PgColumn, value: string) {
  const rows = await tx.select({ key }).from(getColumnTable(key)).where(eq(key, value)).limit(1);
  return new ApiFailure(rows.length > 0 ? 'forbidden' : 'not_found');
}

/** A new subject for a topology entity, in the entity's organisation, labelled as the entity is named. */
export async function newSubject(tx: Transaction, organisationId: string, kind: string, label: string | null) {
  const [subject] = await tx.insert(subjects).values({ organisationId, kind, label }).returning({ id: subjects.id });
  return subject!.id;
}
