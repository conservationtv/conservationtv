import { and, eq } from 'drizzle-orm';
import { agents, networks } from '../db/schema.ts';
import { useDB } from '../db/transaction.ts';
import { ApiFailure } from '../errors.ts';
import { unchanged } from '../topology/transaction.ts';

// An organisation's managed networks, and which of the agents on each is active. Writes the principal may not make
// reach no rows rather than fail, so each write checks what it left behind.

export interface NewNetwork {
  name: string;
}

export interface NetworkChanges {
  name: string;
}

/** The organisation's networks, oldest first, each with its active agent, if any. */
export function listNetworks(organisationId: string) {
  const db = useDB();
  return db.query.networks.findMany({
    columns: { id: true, name: true, createdAt: true },
    with: { activeAgent: { columns: { id: true } } },
    where: { organisationId },
    orderBy: { id: 'asc' }
  });
}

/** The network, with its active agent, if it is visible. */
export function getNetwork(organisationId: string, networkId: string) {
  const db = useDB();
  return db.query.networks.findFirst({
    columns: { id: true, name: true, createdAt: true },
    with: { activeAgent: { columns: { id: true } } },
    where: { organisationId, id: networkId }
  });
}

export async function createNetwork(organisationId: string, payload: NewNetwork) {
  const db = useDB();
  const [network] = await db
    .insert(networks)
    .values({ organisationId, name: payload.name })
    .returning({ id: networks.id });
  return network!;
}

/** Rename the network: `forbidden` or `not_found` when the write reaches no row. */
export async function updateNetwork(organisationId: string, networkId: string, changes: NetworkChanges) {
  const db = useDB();
  const updated = await db
    .update(networks)
    .set({ name: changes.name })
    .where(and(eq(networks.organisationId, organisationId), eq(networks.id, networkId)))
    .returning({ id: networks.id });
  if (updated.length === 0) throw await unchanged(networks.id, networkId);
}

/** Delete the network: `forbidden` or `not_found` when the write reaches no row. */
export async function deleteNetwork(organisationId: string, networkId: string) {
  const db = useDB();
  const deleted = await db
    .delete(networks)
    .where(and(eq(networks.organisationId, organisationId), eq(networks.id, networkId)))
    .returning({ id: networks.id });
  if (deleted.length === 0) throw await unchanged(networks.id, networkId);
}

/**
 * Make the network's active agent a standby, so another can be made active: the partial unique index allows one per
 * network. `forbidden` if one is still active after.
 */
export async function standDownActiveAgent(organisationId: string, networkId: string) {
  const db = useDB();
  const active = and(
    eq(agents.organisationId, organisationId),
    eq(agents.networkId, networkId),
    eq(agents.active, true)
  );
  await db.update(agents).set({ active: false }).where(active);
  const [stillActive] = await db.select({ id: agents.id }).from(agents).where(active);
  if (stillActive) throw new ApiFailure('forbidden');
}

/**
 * Make one of the network's agents its active one, once none is: `invalid_reference` if the agent is not on the
 * network, `forbidden` if it is but the principal may not.
 */
export async function activateAgent(organisationId: string, networkId: string, agentId: string) {
  const db = useDB();
  const onNetwork = and(
    eq(agents.organisationId, organisationId),
    eq(agents.networkId, networkId),
    eq(agents.id, agentId)
  );
  const [activated] = await db.update(agents).set({ active: true }).where(onNetwork).returning({ id: agents.id });
  if (activated) return;
  const [registered] = await db.select({ id: agents.id }).from(agents).where(onNetwork);
  throw new ApiFailure(registered ? 'forbidden' : 'invalid_reference');
}
