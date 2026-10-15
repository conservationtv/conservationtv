import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { agents, networks, subjects } from '../db/schema.ts';
import { ApiFailure } from '../errors.ts';
import { requirePrincipal, usePrincipal } from '../middleware/principal.ts';
import { useServices } from '../services.ts';
import { newSubject, unchanged } from '../topology/transaction.ts';
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

// An organisation's managed networks, in the principal's request session: members read them, administrators manage
// them. Each network has a subject of its own, labelled with its name. Agents are under /organisations/{id}/agents.
export default new Hono()
  .get(
    '/:id/networks',
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
      const services = useServices();
      const principal = usePrincipal();
      const session = await services.session(principal);
      const rows = await session.transaction(tx =>
        tx
          .select({
            id: networks.id,
            subjectId: networks.subjectId,
            name: networks.name,
            activeAgentId: agents.id,
            createdAt: networks.createdAt
          })
          .from(networks)
          .leftJoin(agents, and(eq(agents.networkId, networks.id), eq(agents.active, true)))
          .where(eq(networks.organisationId, id))
          .orderBy(networks.id)
      );
      c.header('Cache-Control', 'no-store');
      return c.json({ networks: rows }, 200);
    }
  )
  .post(
    '/:id/networks',
    describeRoute({
      operationId: 'organisations.networks.create',
      ...operationVersion(1),
      summary: 'Create a network',
      description: 'Administrators only. The network gets a subject of its own.',
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
      const services = useServices();
      const principal = usePrincipal();
      const session = await services.session(principal);
      const [row] = await session.transaction(async tx =>
        tx
          .insert(networks)
          .values({ organisationId: id, subjectId: await newSubject(tx, id, 'network', name), name })
          .returning({
            id: networks.id,
            subjectId: networks.subjectId,
            name: networks.name,
            createdAt: networks.createdAt
          })
      );
      c.header('Cache-Control', 'no-store');
      return c.json({ ...row!, activeAgentId: null }, 201);
    }
  )
  .get(
    '/:id/networks/:networkId',
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
      const services = useServices();
      const principal = usePrincipal();
      const session = await services.session(principal);
      const [row] = await session.transaction(tx =>
        tx
          .select({
            id: networks.id,
            subjectId: networks.subjectId,
            name: networks.name,
            activeAgentId: agents.id,
            createdAt: networks.createdAt
          })
          .from(networks)
          .leftJoin(agents, and(eq(agents.networkId, networks.id), eq(agents.active, true)))
          .where(and(eq(networks.organisationId, id), eq(networks.id, networkId)))
      );
      if (!row) throw new ApiFailure('not_found');
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .patch(
    '/:id/networks/:networkId',
    describeRoute({
      operationId: 'organisations.networks.update',
      ...operationVersion(1),
      summary: 'Rename a network',
      description: "Administrators only. Relabels the network's subject too.",
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
      const services = useServices();
      const principal = usePrincipal();
      const session = await services.session(principal);
      const row = await session.transaction(async tx => {
        const [network] = await tx
          .update(networks)
          .set({ name })
          .where(and(eq(networks.organisationId, id), eq(networks.id, networkId)))
          .returning({
            id: networks.id,
            subjectId: networks.subjectId,
            name: networks.name,
            createdAt: networks.createdAt
          });
        if (!network) throw await unchanged(tx, networks.id, networkId);
        await tx.update(subjects).set({ label: name }).where(eq(subjects.id, network.subjectId));
        const [active] = await tx
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.networkId, networkId), eq(agents.active, true)));
        return { ...network, activeAgentId: active?.id ?? null };
      });
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .delete(
    '/:id/networks/:networkId',
    describeRoute({
      operationId: 'organisations.networks.delete',
      ...operationVersion(1),
      summary: 'Delete a network',
      description:
        'Administrators only. Refused while agents, devices or exposures use it. Its subject remains until the subject is deleted.',
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
      const services = useServices();
      const principal = usePrincipal();
      const session = await services.session(principal);
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
    '/:id/networks/:networkId/active-agent',
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
      const services = useServices();
      const principal = usePrincipal();
      const session = await services.session(principal);
      const row = await session.transaction(async tx => {
        const [network] = await tx
          .select({
            id: networks.id,
            subjectId: networks.subjectId,
            name: networks.name,
            createdAt: networks.createdAt
          })
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
        return { ...network, activeAgentId: agentId };
      });
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  );
