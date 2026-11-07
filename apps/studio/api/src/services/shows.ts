import { and, eq } from 'drizzle-orm';
import { showOutputs } from '../db/schema.ts';
import { useDB } from '../db/transaction.ts';
import { unchanged } from '../topology/transaction.ts';

// Where each show goes out (src/db/schemas/shows.ts), in the principal's request session: members read it,
// administrators set it. Which show a device is the output of is read by trusted code, as a device principal cannot
// read the topology.

/** The show's output, if it has one and it is visible. */
export async function getShowOutput(organisationId: string, showId: string) {
  const db = useDB();
  const [row] = await db
    .select({ showId: showOutputs.showId, deviceId: showOutputs.deviceId, createdAt: showOutputs.createdAt })
    .from(showOutputs)
    .where(and(eq(showOutputs.organisationId, organisationId), eq(showOutputs.showId, showId)));
  return row;
}

/** Send the show out through the agent, in place of any other: the agent must be the organisation's. */
export async function setShowOutput(organisationId: string, showId: string, deviceId: string) {
  const db = useDB();
  const [row] = await db
    .insert(showOutputs)
    .values({ showId, organisationId, deviceId })
    .onConflictDoUpdate({ target: showOutputs.showId, set: { deviceId } })
    .returning({ showId: showOutputs.showId, deviceId: showOutputs.deviceId, createdAt: showOutputs.createdAt });
  return row!;
}

/** Stop sending the show out: `forbidden` or `not_found` when the write reaches no row. */
export async function deleteShowOutput(organisationId: string, showId: string) {
  const db = useDB();
  const deleted = await db
    .delete(showOutputs)
    .where(and(eq(showOutputs.organisationId, organisationId), eq(showOutputs.showId, showId)))
    .returning({ showId: showOutputs.showId });
  if (deleted.length === 0) throw await unchanged(showOutputs.showId, showId);
}

/** The show the device is the output of, if any. Trusted code: a device cannot read the topology. */
export async function selectOutputShow(deviceId: string) {
  const db = useDB({ trusted: true });
  const [row] = await db
    .select({ showId: showOutputs.showId, organisationId: showOutputs.organisationId })
    .from(showOutputs)
    .where(eq(showOutputs.deviceId, deviceId))
    .limit(1);
  return row;
}
