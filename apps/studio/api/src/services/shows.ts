import { and, eq } from 'drizzle-orm';
import { outputs, shows } from '../db/schema.ts';
import { useDB } from '../db/transaction.ts';
import { unchanged } from '../topology/transaction.ts';

// An organisation's shows (src/db/schemas/shows.ts), in the principal's request session: members read them,
// administrators manage them. A show is what is on screen, composed by its object (src/shows/host.tsx); how it goes out
// is each output's that follows it (src/services/outputs.ts).

export interface NewShow {
  name: string;
}

export interface ShowChanges {
  name?: string;
}

/** A show's own columns, as every read and write returns them. */
const SHOW_COLUMNS = { id: true, name: true, createdAt: true } as const;

/** The outputs following a show, as its reads return them. */
const SHOW_OUTPUTS = { outputs: { columns: { id: true, name: true }, orderBy: { id: 'asc' } } } as const;

/** The organisation's shows, oldest first, each with the outputs following it. */
export function listShows(organisationId: string) {
  const db = useDB();
  return db.query.shows.findMany({
    columns: SHOW_COLUMNS,
    with: SHOW_OUTPUTS,
    where: { organisationId },
    orderBy: { id: 'asc' }
  });
}

/** The show, with the outputs following it, if it is visible. */
export function getShow(organisationId: string, showId: string) {
  const db = useDB();
  return db.query.shows.findFirst({ columns: SHOW_COLUMNS, with: SHOW_OUTPUTS, where: { organisationId, id: showId } });
}

/** Whether the show is visible: what reaching its object checks first, so a show that is not there is `not_found`. */
export async function showVisible(organisationId: string, showId: string) {
  const db = useDB();
  const [row] = await db
    .select({ id: shows.id })
    .from(shows)
    .where(and(eq(shows.organisationId, organisationId), eq(shows.id, showId)));
  return row !== undefined;
}

export async function createShow(organisationId: string, payload: NewShow) {
  const db = useDB();
  const [row] = await db
    .insert(shows)
    .values({ organisationId, name: payload.name })
    .returning({ id: shows.id, name: shows.name, createdAt: shows.createdAt });
  return row!;
}

/** Rename the show: `forbidden` or `not_found` when the write reaches no row. */
export async function updateShow(organisationId: string, showId: string, changes: ShowChanges) {
  const db = useDB();
  const [row] = await db
    .update(shows)
    .set({ name: changes.name })
    .where(and(eq(shows.organisationId, organisationId), eq(shows.id, showId)))
    .returning({ id: shows.id, name: shows.name, createdAt: shows.createdAt });
  if (!row) throw await unchanged(shows.id, showId);
  return row;
}

/**
 * Delete the show, leaving the outputs that followed it following nothing: `forbidden` or `not_found` when the write
 * reaches no row. Its object keeps its last composition, unreachable.
 */
export async function deleteShow(organisationId: string, showId: string) {
  const db = useDB();
  await db
    .update(outputs)
    .set({ showId: null })
    .where(and(eq(outputs.organisationId, organisationId), eq(outputs.showId, showId)));
  const deleted = await db
    .delete(shows)
    .where(and(eq(shows.organisationId, organisationId), eq(shows.id, showId)))
    .returning({ id: shows.id });
  if (deleted.length === 0) throw await unchanged(shows.id, showId);
}
