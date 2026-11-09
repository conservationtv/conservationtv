import { device } from '@conservationtv/umbrella';
import { and, eq } from 'drizzle-orm';
import { channelBroadcaster } from '../db/roles.ts';
import { showOutputs } from '../db/schema.ts';
import { useAccess, useDB } from '../db/transaction.ts';
import { unchanged } from '../topology/transaction.ts';
import { organisationScope } from './organisations.ts';

// Where each show goes out (src/db/schemas/shows.ts), in the principal's request session: members read it,
// administrators set it. Which show a device is the output of is read by trusted code, as a device principal cannot
// read the topology. The output is granted `channelBroadcaster`, to read the stream keys of the channels it sends the
// show out to, for as long as it is the output, and no longer (`syncBroadcasters`).

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

/**
 * Grant `channelBroadcaster` at the organisation to the devices its shows go out through, and revoke it from any other
 * device holding it: after an output is set or removed. Trusted code, so it can grant; run once the request session has
 * made the change, which row-level security allowed only an administrator to.
 */
export async function syncBroadcasters(organisationId: string) {
  const db = useDB({ trusted: true });
  const access = useAccess();
  const scope = organisationScope(organisationId);
  const outputs = await db
    .select({ deviceId: showOutputs.deviceId })
    .from(showOutputs)
    .where(eq(showOutputs.organisationId, organisationId));
  const wanted = new Set(outputs.map(output => output.deviceId));
  const held = await access.grantsQuery({ role: channelBroadcaster, scope });
  for (const grant of held) {
    if (grant.principalKind !== 'device' || wanted.has(grant.principalId)) continue;
    await access.at(scope).revoke({ principal: device(grant.principalId), role: channelBroadcaster });
  }
  for (const deviceId of wanted) {
    await access.at(scope).grant({ principal: device(deviceId), role: channelBroadcaster });
  }
}
