import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { agents, configurationRevisions } from '../db/schema.ts';
import { ApiFailure } from '../errors.ts';
import { requirePrincipal, usePrincipal } from '../middleware/principal.ts';
import { useServices } from '../services.ts';
import { BuildDiagnosticSchema, SettingsSchema } from '../topology/settings.ts';
import { unchanged } from '../topology/transaction.ts';
import {
  forbidden,
  invalidReference,
  invalidRequest,
  notFound,
  operationVersion,
  revisionHasErrors,
  unauthenticated,
  unavailable,
  validator,
  versionMismatch
} from './openapi.ts';

const OrganisationParamsSchema = z.object({ id: z.uuid().describe('The organisation.') });
export type OrganisationParams = z.output<typeof OrganisationParamsSchema>;
const AgentParamsSchema = OrganisationParamsSchema.extend({ agentId: z.uuid().describe('The agent.') });
export type AgentParams = z.output<typeof AgentParamsSchema>;
const SigningKeyParamsSchema = AgentParamsSchema.extend({ keyId: z.uuid().describe('The signing key.') });
export type SigningKeyParams = z.output<typeof SigningKeyParamsSchema>;
const RevisionParamsSchema = AgentParamsSchema.extend({ revisionId: z.uuid().describe('The configuration revision.') });
export type RevisionParams = z.output<typeof RevisionParamsSchema>;

const PrioritySchema = z.int().min(-1000).max(1000).describe('Standby preference; higher is preferred.');
export type Priority = z.output<typeof PrioritySchema>;

// An organisation's agents and their configuration revisions, in the principal's request
// session: members read them, administrators manage them. An agent serves one network from a host device of the same
// organisation (the database's composite foreign keys refuse any other).
export default new Hono()
  .get(
    '/:id/agents',
    describeRoute({
      operationId: 'organisations.agents.list',
      ...operationVersion(1),
      summary: "List an organisation's agents",
      description: 'Optionally only those registered on one network. Empty for organisations you are not a member of.',
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
      const services = useServices();
      const principal = usePrincipal();
      const session = await services.session(principal);
      const rows = await session.transaction(tx =>
        tx
          .select({
            id: agents.id,
            networkId: agents.networkId,
            deviceId: agents.deviceId,
            priority: agents.priority,
            active: agents.active,
            servedRevisionId: configurationRevisions.id,
            createdAt: agents.createdAt
          })
          .from(agents)
          .leftJoin(
            configurationRevisions,
            and(eq(configurationRevisions.agentId, agents.id), eq(configurationRevisions.served, true))
          )
          .where(
            and(eq(agents.organisationId, id), networkId === undefined ? undefined : eq(agents.networkId, networkId))
          )
          .orderBy(agents.id)
      );
      c.header('Cache-Control', 'no-store');
      return c.json({ agents: rows }, 200);
    }
  )
  .post(
    '/:id/agents',
    describeRoute({
      operationId: 'organisations.agents.create',
      ...operationVersion(1),
      summary: 'Register an agent',
      description:
        'Administrators only. The agent serves a network of the organisation from one of its devices, and starts as a standby.',
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
        networkId: z.uuid().describe('The network the agent serves.'),
        deviceId: z.uuid().describe('The device the agent runs on.'),
        priority: PrioritySchema.default(0)
      })
    ),
    async c => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const services = useServices();
      const principal = usePrincipal();
      const session = await services.session(principal);
      const [row] = await session.transaction(async tx =>
        tx
          .insert(agents)
          .values({
            organisationId: id,
            networkId: body.networkId,
            deviceId: body.deviceId,
            priority: body.priority
          })
          .returning({
            id: agents.id,
            networkId: agents.networkId,
            deviceId: agents.deviceId,
            priority: agents.priority,
            active: agents.active,
            createdAt: agents.createdAt
          })
      );
      c.header('Cache-Control', 'no-store');
      return c.json({ ...row!, servedRevisionId: null }, 201);
    }
  )
  .get(
    '/:id/agents/:agentId',
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
      const services = useServices();
      const principal = usePrincipal();
      const session = await services.session(principal);
      const [row] = await session.transaction(tx =>
        tx
          .select({
            id: agents.id,
            networkId: agents.networkId,
            deviceId: agents.deviceId,
            priority: agents.priority,
            active: agents.active,
            servedRevisionId: configurationRevisions.id,
            createdAt: agents.createdAt
          })
          .from(agents)
          .leftJoin(
            configurationRevisions,
            and(eq(configurationRevisions.agentId, agents.id), eq(configurationRevisions.served, true))
          )
          .where(and(eq(agents.organisationId, id), eq(agents.id, agentId)))
      );
      if (!row) throw new ApiFailure('not_found');
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .patch(
    '/:id/agents/:agentId',
    describeRoute({
      operationId: 'organisations.agents.update',
      ...operationVersion(1),
      summary: 'Update an agent',
      description:
        'Administrators only: move it to another device, or change its priority. An agent stays on its network; which agent is active is set on the network.',
      responses: {
        200: { description: 'The updated agent' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        412: versionMismatch,
        422: invalidReference,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', AgentParamsSchema),
    validator(
      'json',
      z
        .strictObject({
          deviceId: z.uuid().optional().describe('The device the agent runs on.'),
          priority: PrioritySchema.optional()
        })
        .refine(changes => Object.keys(changes).length > 0, 'Provide at least one field to change')
    ),
    async c => {
      const { id, agentId } = c.req.valid('param');
      const body = c.req.valid('json');
      const services = useServices();
      const principal = usePrincipal();
      const session = await services.session(principal);
      const row = await session.transaction(async tx => {
        const [agent] = await tx
          .update(agents)
          .set({ deviceId: body.deviceId, priority: body.priority })
          .where(and(eq(agents.organisationId, id), eq(agents.id, agentId)))
          .returning({
            id: agents.id,
            networkId: agents.networkId,
            deviceId: agents.deviceId,
            priority: agents.priority,
            active: agents.active,
            createdAt: agents.createdAt
          });
        if (!agent) throw await unchanged(tx, agents.id, agentId);
        const [served] = await tx
          .select({ id: configurationRevisions.id })
          .from(configurationRevisions)
          .where(and(eq(configurationRevisions.agentId, agentId), eq(configurationRevisions.served, true)));
        return { ...agent, servedRevisionId: served?.id ?? null };
      });
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .delete(
    '/:id/agents/:agentId',
    describeRoute({
      operationId: 'organisations.agents.delete',
      ...operationVersion(1),
      summary: 'Remove an agent',
      description: 'Administrators only. Deletes its configuration revisions.',
      responses: {
        204: { description: 'Removed' },
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
    async c => {
      const { id, agentId } = c.req.valid('param');
      const services = useServices();
      const principal = usePrincipal();
      const session = await services.session(principal);
      await session.transaction(async tx => {
        const deleted = await tx
          .delete(agents)
          .where(and(eq(agents.organisationId, id), eq(agents.id, agentId)))
          .returning({ id: agents.id });
        if (deleted.length === 0) throw await unchanged(tx, agents.id, agentId);
      });
      return c.body(null, 204);
    }
  )
  .get(
    '/:id/agents/:agentId/revisions',
    describeRoute({
      operationId: 'organisations.agents.revisions.list',
      ...operationVersion(1),
      summary: "List an agent's configuration revisions",
      description:
        'Newest first, with their diagnostics but not their configuration, which is read one revision at a time.',
      responses: {
        200: { description: 'The revisions, newest first' },
        400: invalidRequest,
        401: unauthenticated,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', AgentParamsSchema),
    validator('query', z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) })),
    async c => {
      const { id, agentId } = c.req.valid('param');
      const { limit } = c.req.valid('query');
      const services = useServices();
      const principal = usePrincipal();
      const session = await services.session(principal);
      const rows = await session.transaction(tx =>
        tx
          .select({
            id: configurationRevisions.id,
            diagnostics: configurationRevisions.diagnostics,
            hasErrors: configurationRevisions.hasErrors,
            served: configurationRevisions.served,
            createdAt: configurationRevisions.createdAt
          })
          .from(configurationRevisions)
          .where(and(eq(configurationRevisions.organisationId, id), eq(configurationRevisions.agentId, agentId)))
          .orderBy(desc(configurationRevisions.id))
          .limit(limit)
      );
      c.header('Cache-Control', 'no-store');
      return c.json({ revisions: rows }, 200);
    }
  )
  .post(
    '/:id/agents/:agentId/revisions',
    describeRoute({
      operationId: 'organisations.agents.revisions.create',
      ...operationVersion(1),
      summary: 'Record a candidate configuration',
      description:
        'Administrators only. A rendered configuration and every diagnostic its builders reported. Recording it changes nothing the agent is served: serving is a separate step, refused for a candidate with any error.',
      responses: {
        201: { description: 'The candidate revision' },
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
    validator(
      'json',
      z.strictObject({
        config: SettingsSchema.describe('The rendered configuration.'),
        diagnostics: z.array(BuildDiagnosticSchema).max(1000).default([])
      })
    ),
    async c => {
      const { id, agentId } = c.req.valid('param');
      const body = c.req.valid('json');
      const services = useServices();
      const principal = usePrincipal();
      const session = await services.session(principal);
      const row = await session.transaction(async tx => {
        const [agent] = await tx
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.organisationId, id), eq(agents.id, agentId)));
        if (!agent) throw new ApiFailure('not_found');
        const [revision] = await tx
          .insert(configurationRevisions)
          .values({ organisationId: id, agentId, config: body.config, diagnostics: body.diagnostics })
          .returning({
            id: configurationRevisions.id,
            config: configurationRevisions.config,
            diagnostics: configurationRevisions.diagnostics,
            hasErrors: configurationRevisions.hasErrors,
            served: configurationRevisions.served,
            createdAt: configurationRevisions.createdAt
          });
        return revision!;
      });
      c.header('Cache-Control', 'no-store');
      return c.json(row, 201);
    }
  )
  .get(
    '/:id/agents/:agentId/revisions/:revisionId',
    describeRoute({
      operationId: 'organisations.agents.revisions.get',
      ...operationVersion(1),
      summary: 'Read a configuration revision',
      description: 'With its configuration.',
      responses: {
        200: { description: 'The revision' },
        400: invalidRequest,
        401: unauthenticated,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', RevisionParamsSchema),
    async c => {
      const { id, agentId, revisionId } = c.req.valid('param');
      const services = useServices();
      const principal = usePrincipal();
      const session = await services.session(principal);
      const [row] = await session.transaction(tx =>
        tx
          .select({
            id: configurationRevisions.id,
            config: configurationRevisions.config,
            diagnostics: configurationRevisions.diagnostics,
            hasErrors: configurationRevisions.hasErrors,
            served: configurationRevisions.served,
            createdAt: configurationRevisions.createdAt
          })
          .from(configurationRevisions)
          .where(
            and(
              eq(configurationRevisions.organisationId, id),
              eq(configurationRevisions.agentId, agentId),
              eq(configurationRevisions.id, revisionId)
            )
          )
      );
      if (!row) throw new ApiFailure('not_found');
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .put(
    '/:id/agents/:agentId/served-revision',
    describeRoute({
      operationId: 'organisations.agents.serveRevision',
      ...operationVersion(1),
      summary: 'Serve a configuration revision to an agent',
      description:
        'Administrators only. Activates one of the agent’s revisions, which must have no errors; the agent keeps its current revision otherwise. Serving the served revision again changes nothing.',
      responses: {
        200: { description: 'The agent' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        409: revisionHasErrors,
        412: versionMismatch,
        422: invalidReference,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', AgentParamsSchema),
    validator('json', z.strictObject({ revisionId: z.uuid().describe('A revision of this agent without errors.') })),
    async c => {
      const { id, agentId } = c.req.valid('param');
      const { revisionId } = c.req.valid('json');
      const services = useServices();
      const principal = usePrincipal();
      const session = await services.session(principal);
      const row = await session.transaction(async tx => {
        const [agent] = await tx
          .select({
            id: agents.id,
            networkId: agents.networkId,
            deviceId: agents.deviceId,
            priority: agents.priority,
            active: agents.active,
            createdAt: agents.createdAt
          })
          .from(agents)
          .where(and(eq(agents.organisationId, id), eq(agents.id, agentId)));
        if (!agent) throw new ApiFailure('not_found');
        const [revision] = await tx
          .select({ hasErrors: configurationRevisions.hasErrors, served: configurationRevisions.served })
          .from(configurationRevisions)
          .where(and(eq(configurationRevisions.agentId, agentId), eq(configurationRevisions.id, revisionId)));
        if (!revision) throw new ApiFailure('invalid_reference');
        // The diagnostic gate, checked before anything changes; the table's check constraint enforces it again.
        if (revision.hasErrors) throw new ApiFailure('revision_has_errors');
        if (!revision.served) {
          // One served revision per agent (a partial unique index): stop serving the current one first.
          await tx
            .update(configurationRevisions)
            .set({ served: false })
            .where(and(eq(configurationRevisions.agentId, agentId), eq(configurationRevisions.served, true)));
          const [served] = await tx
            .update(configurationRevisions)
            .set({ served: true })
            .where(eq(configurationRevisions.id, revisionId))
            .returning({ id: configurationRevisions.id });
          if (!served) throw new ApiFailure('forbidden');
        }
        return { ...agent, servedRevisionId: revisionId };
      });
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  );
