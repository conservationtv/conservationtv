import { and, eq } from 'drizzle-orm';
import { agents } from '../db/schema.ts';
import { useDB } from '../db/transaction.ts';
import { ApiFailure } from '../errors.ts';
import { unchanged } from '../topology/transaction.ts';

// An organisation's agents (src/db/schemas/agents.ts): each a device that serves the network it is on, sharing its
// device's ID. The agent's row is created and removed beside its device (src/services/devices.ts), in the same
// transaction.

export interface AgentFilter {
  /** Only agents on this network. */
  networkId?: string;
}

export interface NewAgent {
  /** The network the agent is on and serves: its device's. */
  networkId: string;
  priority: number;
}

export interface AgentChanges {
  priority: number;
}

/** The organisation's agents, oldest first, each with its device. */
export function listAgents(organisationId: string, filter: AgentFilter) {
  const db = useDB();
  return db.query.agents.findMany({
    columns: { id: true, networkId: true, priority: true, active: true },
    with: {
      device: {
        columns: { kind: true, name: true, networkId: true, publicKey: true, publicId: true, createdAt: true }
      }
    },
    where: { organisationId, networkId: filter.networkId },
    orderBy: { id: 'asc' }
  });
}

/** The agent, with its device, if it is visible. */
export function getAgent(organisationId: string, agentId: string) {
  const db = useDB();
  return db.query.agents.findFirst({
    columns: { id: true, networkId: true, priority: true, active: true },
    with: {
      device: {
        columns: { kind: true, name: true, networkId: true, publicKey: true, publicId: true, createdAt: true }
      }
    },
    where: { organisationId, id: agentId }
  });
}

/** Make the device an agent, as a standby. */
export async function createAgent(organisationId: string, agentId: string, payload: NewAgent) {
  const db = useDB();
  await db
    .insert(agents)
    .values({ id: agentId, organisationId, networkId: payload.networkId, priority: payload.priority });
}

/** Change the agent's priority: `forbidden` or `not_found` when the write reaches no row. */
export async function updateAgent(organisationId: string, agentId: string, changes: AgentChanges) {
  const db = useDB();
  const updated = await db
    .update(agents)
    .set({ priority: changes.priority })
    .where(and(eq(agents.organisationId, organisationId), eq(agents.id, agentId)))
    .returning({ id: agents.id });
  if (updated.length === 0) throw await unchanged(agents.id, agentId);
}

/** Delete the agent's row, before its device: `not_found` if there is none. */
export async function deleteAgent(organisationId: string, agentId: string) {
  const db = useDB();
  const deleted = await db
    .delete(agents)
    .where(and(eq(agents.organisationId, organisationId), eq(agents.id, agentId)))
    .returning({ id: agents.id });
  if (deleted.length === 0) throw new ApiFailure('not_found');
}
