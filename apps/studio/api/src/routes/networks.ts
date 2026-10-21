import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { agents, networks } from '../db/schema.ts';
import { ApiFailure } from '../errors.ts';
import { requirePrincipal, usePrincipal } from '../middleware/principal.ts';
import { useEnvironment } from '../env/env.ts';
import type { Transaction } from '../organisations/membership.ts';
import { unchanged } from '../topology/transaction.ts';
import {
  conflict,
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
const NetworkParamsSchema = OrganisationParamsSchema.extend({ networkId: z.uuid().describe('The network.') });
export type NetworkParams = z.output<typeof NetworkParamsSchema>;

/** A network as every network route returns it, with the agent active on it, if any. */
const networkQuery = {
  columns: { id: true, name: true, createdAt: true },
  with: { activeAgent: { columns: { id: true } } }
} as const;

/** The network, as its routes return it. */
function readNetwork(tx: Transaction, organisationId: string, networkId: string) {
  return tx.query.networks.findFirst({ ...networkQuery, where: { organisationId, id: networkId } });
}

// An organisation's managed networks, in the principal's request session: members read them, administrators manage
// them. Agents are under /organisations/{id}/agents.
export default new Hono()
  .get(
    '/',
    describeRoute({
      operationId: 'organisations.networks.list',
      ...operationVersion(1),
      summary: "List an organisation's networks",
      description:
        'Each with the agent currently active on it, if any. Empty for organisations you are not a member of.',
      responses: {
        200: { description: 'The networks, oldest first' },
        400: invalidRequest,
        401: unauthenticated,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', OrganisationParamsSchema),
    async c => {
      const { id } = c.req.valid('param');
      const environment = useEnvironment();
      const principal = usePrincipal();
      const session = await environment.session(principal);
      const rows = await session.transaction(tx =>
        tx.query.networks.findMany({ ...networkQuery, where: { organisationId: id }, orderBy: { id: 'asc' } })
      );
      c.header('Cache-Control', 'no-store');
      return c.json({ networks: rows }, 200);
    }
  )
  .post(
    '/',
    describeRoute({
      operationId: 'organisations.networks.create',
      ...operationVersion(1),
      summary: 'Create a network',
      description: 'Administrators only.',
      responses: {
        201: { description: 'The new network' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', OrganisationParamsSchema),
    validator('json', z.strictObject({ name: z.string().trim().min(1).max(120).describe('The network name.') })),
    async c => {
      const { id } = c.req.valid('param');
      const { name } = c.req.valid('json');
      const environment = useEnvironment();
      const principal = usePrincipal();
      const session = await environment.session(principal);
      const row = await session.transaction(async tx => {
        const [network] = await tx.insert(networks).values({ organisationId: id, name }).returning({ id: networks.id });
        const created = await readNetwork(tx, id, network!.id);
        return created!;
      });
      c.header('Cache-Control', 'no-store');
      return c.json(row, 201);
    }
  )
  .get(
    '/:networkId',
    describeRoute({
      operationId: 'organisations.networks.get',
      ...operationVersion(1),
      summary: 'Read a network',
      responses: {
        200: { description: 'The network' },
        400: invalidRequest,
        401: unauthenticated,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', NetworkParamsSchema),
    async c => {
      const { id, networkId } = c.req.valid('param');
      const environment = useEnvironment();
      const principal = usePrincipal();
      const session = await environment.session(principal);
      const row = await session.transaction(tx => readNetwork(tx, id, networkId));
      if (!row) throw new ApiFailure('not_found');
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .patch(
    '/:networkId',
    describeRoute({
      operationId: 'organisations.networks.update',
      ...operationVersion(1),
      summary: 'Rename a network',
      description: 'Administrators only.',
      responses: {
        200: { description: 'The updated network' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', NetworkParamsSchema),
    validator('json', z.strictObject({ name: z.string().trim().min(1).max(120).describe('The network name.') })),
    async c => {
      const { id, networkId } = c.req.valid('param');
      const { name } = c.req.valid('json');
      const environment = useEnvironment();
      const principal = usePrincipal();
      const session = await environment.session(principal);
      const row = await session.transaction(async tx => {
        const updated = await tx
          .update(networks)
          .set({ name })
          .where(and(eq(networks.organisationId, id), eq(networks.id, networkId)))
          .returning({ id: networks.id });
        if (updated.length === 0) throw await unchanged(tx, networks.id, networkId);
        const network = await readNetwork(tx, id, networkId);
        return network!;
      });
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .delete(
    '/:networkId',
    describeRoute({
      operationId: 'organisations.networks.delete',
      ...operationVersion(1),
      summary: 'Delete a network',
      description: 'Administrators only. Refused while agents, devices or gateways use it.',
      responses: {
        204: { description: 'Deleted' },
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
    validator('param', NetworkParamsSchema),
    async c => {
      const { id, networkId } = c.req.valid('param');
      const environment = useEnvironment();
      const principal = usePrincipal();
      const session = await environment.session(principal);
      await session.transaction(async tx => {
        const deleted = await tx
          .delete(networks)
          .where(and(eq(networks.organisationId, id), eq(networks.id, networkId)))
          .returning({ id: networks.id });
        if (deleted.length === 0) throw await unchanged(tx, networks.id, networkId);
      });
      return c.body(null, 204);
    }
  )
  .put(
    '/:networkId/active-agent',
    describeRoute({
      operationId: 'organisations.networks.setActiveAgent',
      ...operationVersion(1),
      summary: "Choose a network's active agent",
      description:
        'Administrators only. Makes one of the agents registered on the network the active one, or (`agentId` null) none. The previously active agent becomes a standby.',
      responses: {
        200: { description: 'The network' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        409: conflict,
        422: invalidReference,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', NetworkParamsSchema),
    validator(
      'json',
      z.strictObject({
        agentId: z.uuid().nullable().describe('An agent registered on this network, or null for none.')
      })
    ),
    async c => {
      const { id, networkId } = c.req.valid('param');
      const { agentId } = c.req.valid('json');
      const environment = useEnvironment();
      const principal = usePrincipal();
      const session = await environment.session(principal);
      const row = await session.transaction(async tx => {
        const [network] = await tx
          .select({ id: networks.id })
          .from(networks)
          .where(and(eq(networks.organisationId, id), eq(networks.id, networkId)));
        if (!network) throw new ApiFailure('not_found');
        // Stand the current agent down first: the partial unique index allows one active agent per network.
        await tx
          .update(agents)
          .set({ active: false })
          .where(and(eq(agents.networkId, networkId), eq(agents.active, true)));
        // Writes the principal may not make reach no rows rather than fail, so check what each one left behind.
        if (agentId === null) {
          const [stillActive] = await tx
            .select({ id: agents.id })
            .from(agents)
            .where(and(eq(agents.networkId, networkId), eq(agents.active, true)));
          if (stillActive) throw new ApiFailure('forbidden');
        } else {
          const [activated] = await tx
            .update(agents)
            .set({ active: true })
            .where(and(eq(agents.networkId, networkId), eq(agents.id, agentId)))
            .returning({ id: agents.id });
          if (!activated) {
            const [registered] = await tx
              .select({ id: agents.id })
              .from(agents)
              .where(and(eq(agents.networkId, networkId), eq(agents.id, agentId)));
            throw new ApiFailure(registered ? 'forbidden' : 'invalid_reference');
          }
        }
        const changed = await readNetwork(tx, id, networkId);
        return changed!;
      });
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  );
