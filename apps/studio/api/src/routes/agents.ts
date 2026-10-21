import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { agents, devices } from '../db/schema.ts';
import { ApiFailure } from '../errors.ts';
import { requirePrincipal, usePrincipal } from '../middleware/principal.ts';
import { useEnvironment } from '../env/env.ts';
import { changeDevices, grantDevice, revokeDevice } from '../topology/device-principals.ts';
import { DeviceNameSchema, deviceQuery } from './devices.ts';
import { deviceIdentity } from '../topology/identity.ts';
import type { Transaction } from '../organisations/membership.ts';
import { unchanged } from '../topology/transaction.ts';
import {
  forbidden,
  inUse,
  invalidReference,
  invalidRequest,
  notFound,
  operationVersion,
  unauthenticated,
  unavailable,
  validator,
  versionMismatch
} from './openapi.ts';

const OrganisationParamsSchema = z.object({ id: z.uuid().describe('The organisation.') });
export type OrganisationParams = z.output<typeof OrganisationParamsSchema>;
const AgentParamsSchema = OrganisationParamsSchema.extend({ agentId: z.uuid().describe('The agent.') });
export type AgentParams = z.output<typeof AgentParamsSchema>;

const PrioritySchema = z.int().min(-1000).max(1000).describe('Standby preference; higher is preferred.');
export type Priority = z.output<typeof PrioritySchema>;

/** An agent as every agent route returns it: its own fields and its device's. */
const agentQuery = {
  columns: { id: true, networkId: true, priority: true, active: true },
  with: { device: deviceQuery }
} as const;

/** The agent, as its routes return it. */
function readAgent(tx: Transaction, organisationId: string, agentId: string) {
  return tx.query.agents.findFirst({ ...agentQuery, where: { organisationId, id: agentId } });
}

// An organisation's agents, in the principal's request session: members read them,
// administrators manage them. An agent is a device that serves the network it is on (src/db/schemas/agents.ts): it is
// created and removed with its device, and its device's name is edited under /devices, with the same ID.
export default new Hono()
  .get(
    '/',
    describeRoute({
      operationId: 'organisations.agents.list',
      ...operationVersion(1),
      summary: "List an organisation's agents",
      description: 'Optionally only those on one network. Empty for organisations you are not a member of.',
      responses: {
        200: { description: 'The agents, oldest first' },
        400: invalidRequest,
        401: unauthenticated,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', OrganisationParamsSchema),
    validator('query', z.object({ networkId: z.uuid().optional().describe('Only agents on this network.') })),
    async c => {
      const { id } = c.req.valid('param');
      const { networkId } = c.req.valid('query');
      const environment = useEnvironment();
      const principal = usePrincipal();
      const session = await environment.session(principal);
      const rows = await session.transaction(tx =>
        tx.query.agents.findMany({
          ...agentQuery,
          where: { organisationId: id, networkId },
          orderBy: { id: 'asc' }
        })
      );
      c.header('Cache-Control', 'no-store');
      return c.json({ agents: rows }, 200);
    }
  )
  .post(
    '/',
    describeRoute({
      operationId: 'organisations.agents.create',
      ...operationVersion(1),
      summary: 'Add an agent',
      description:
        'Administrators only. Creates the agent’s device on the network it serves, with a new Ed25519 identity, and the agent as a standby.',
      responses: {
        201: { description: 'The new agent' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        412: versionMismatch,
        422: invalidReference,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', OrganisationParamsSchema),
    validator(
      'json',
      z.strictObject({
        name: DeviceNameSchema,
        networkId: z.uuid().describe('The network the agent is on and serves.'),
        priority: PrioritySchema.default(0)
      })
    ),
    async c => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const principal = usePrincipal();
      const identity = await deviceIdentity();
      // Trusted, so the device's principal grant is made with it (src/topology/device-principals.ts).
      const row = await changeDevices(principal, id, 'create', async (tx, access) => {
        const [device] = await tx
          .insert(devices)
          .values({ ...identity, organisationId: id, kind: 'agent', name: body.name, networkId: body.networkId })
          .returning({ id: devices.id });
        await tx
          .insert(agents)
          .values({ id: device!.id, organisationId: id, networkId: body.networkId, priority: body.priority });
        await grantDevice(access, id, device!.id);
        const agent = await readAgent(tx, id, device!.id);
        return agent!;
      });
      c.header('Cache-Control', 'no-store');
      return c.json(row, 201);
    }
  )
  .get(
    '/:agentId',
    describeRoute({
      operationId: 'organisations.agents.get',
      ...operationVersion(1),
      summary: 'Read an agent',
      responses: {
        200: { description: 'The agent' },
        400: invalidRequest,
        401: unauthenticated,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', AgentParamsSchema),
    async c => {
      const { id, agentId } = c.req.valid('param');
      const environment = useEnvironment();
      const principal = usePrincipal();
      const session = await environment.session(principal);
      const row = await session.transaction(tx => readAgent(tx, id, agentId));
      if (!row) throw new ApiFailure('not_found');
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .patch(
    '/:agentId',
    describeRoute({
      operationId: 'organisations.agents.update',
      ...operationVersion(1),
      summary: 'Update an agent',
      description:
        'Administrators only: change its priority. Its name is changed under `/devices`, with the same ID; which agent is active is set on the network.',
      responses: {
        200: { description: 'The updated agent' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', AgentParamsSchema),
    validator('json', z.strictObject({ priority: PrioritySchema })),
    async c => {
      const { id, agentId } = c.req.valid('param');
      const body = c.req.valid('json');
      const environment = useEnvironment();
      const principal = usePrincipal();
      const session = await environment.session(principal);
      const row = await session.transaction(async tx => {
        const updated = await tx
          .update(agents)
          .set({ priority: body.priority })
          .where(and(eq(agents.organisationId, id), eq(agents.id, agentId)))
          .returning({ id: agents.id });
        if (updated.length === 0) throw await unchanged(tx, agents.id, agentId);
        const agent = await readAgent(tx, id, agentId);
        return agent!;
      });
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .delete(
    '/:agentId',
    describeRoute({
      operationId: 'organisations.agents.delete',
      ...operationVersion(1),
      summary: 'Remove an agent',
      description:
        'Administrators only. Removes its device too; its reports remain. Refused while a stream uses its device as its source.',
      responses: {
        204: { description: 'Removed' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        409: inUse,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', AgentParamsSchema),
    async c => {
      const { id, agentId } = c.req.valid('param');
      const principal = usePrincipal();
      // Trusted, so the device's principal grant is revoked with it (src/topology/device-principals.ts).
      await changeDevices(principal, id, 'remove', async (tx, access) => {
        const deleted = await tx
          .delete(agents)
          .where(and(eq(agents.organisationId, id), eq(agents.id, agentId)))
          .returning({ id: agents.id });
        if (deleted.length === 0) throw new ApiFailure('not_found');
        await tx.delete(devices).where(and(eq(devices.organisationId, id), eq(devices.id, agentId)));
        await revokeDevice(access, id, agentId);
      });
      return c.body(null, 204);
    }
  );
