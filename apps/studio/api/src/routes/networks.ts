import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { transaction } from '../db/transaction.ts';
import { ApiFailure } from '../errors.ts';
import { requirePrincipal } from '../middleware/principal.ts';
import {
  activateAgent,
  createNetwork,
  deleteNetwork,
  getNetwork,
  listNetworks,
  standDownActiveAgent,
  updateNetwork
} from '../services/networks.ts';
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
      const rows = await transaction(() => listNetworks(id));
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
      const body = c.req.valid('json');
      const row = await transaction(async () => {
        const network = await createNetwork(id, body);
        const created = await getNetwork(id, network.id);
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
      const row = await transaction(() => getNetwork(id, networkId));
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
      const body = c.req.valid('json');
      const row = await transaction(async () => {
        await updateNetwork(id, networkId, body);
        const network = await getNetwork(id, networkId);
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
      await transaction(() => deleteNetwork(id, networkId));
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
      const row = await transaction(async () => {
        const network = await getNetwork(id, networkId);
        if (!network) throw new ApiFailure('not_found');
        // Stand the current agent down first: the network has one active agent at most.
        await standDownActiveAgent(id, networkId);
        if (agentId !== null) await activateAgent(id, networkId, agentId);
        const changed = await getNetwork(id, networkId);
        return changed!;
      });
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  );
