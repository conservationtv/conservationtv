import { and, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { gateways } from '../db/schema.ts';
import { ApiFailure } from '../errors.ts';
import { requirePrincipal, usePrincipal } from '../middleware/principal.ts';
import { useEnvironment } from '../env/env.ts';
import { checkGatewayUnused, checkProtocolsInUse } from '../topology/exposures.ts';
import { BUILTIN_GATEWAY_IDS, builtinGateways, checkGatewayKind, isBuiltinGateway } from '../gateways/index.ts';
import { NetworkReferenceSchema, SettingsSchema } from '../topology/settings.ts';
import { unchanged } from '../topology/transaction.ts';
import {
  forbidden,
  inUse,
  invalidGateway,
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
/** A gateway: a built-in gateway's slug, or the ID of one of the organisation's own. */
export const GatewayIdSchema = z.union([z.enum(BUILTIN_GATEWAY_IDS), z.uuid()]).describe('The gateway.');
export type GatewayId = z.output<typeof GatewayIdSchema>;
const GatewayParamsSchema = OrganisationParamsSchema.extend({ gatewayId: GatewayIdSchema });
export type GatewayParams = z.output<typeof GatewayParamsSchema>;

const GatewayNameSchema = z.string().trim().min(1).max(120).describe('The gateway name.');
export type GatewayName = z.output<typeof GatewayNameSchema>;
const GatewayKindSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .describe('The gateway implementation, such as `moq-relay`, `rtmp` or `mediamtx`.');
export type GatewayKind = z.output<typeof GatewayKindSchema>;
export const ProtocolSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .describe('A delivery protocol, such as `moq` or `rtsp`.');
export type Protocol = z.output<typeof ProtocolSchema>;
const ProtocolsSchema = z
  .array(ProtocolSchema)
  .min(1)
  .max(16)
  .refine(protocols => new Set(protocols).size === protocols.length, 'Protocols must be unique')
  .describe('The protocols the gateway accepts streams by.');
export type Protocols = z.output<typeof ProtocolsSchema>;

const GatewayChangesSchema = z
  .strictObject({
    name: GatewayNameSchema.optional(),
    kind: GatewayKindSchema.optional(),
    networkId: NetworkReferenceSchema.optional(),
    protocols: ProtocolsSchema.optional(),
    settings: SettingsSchema.optional()
  })
  .refine(changes => Object.keys(changes).length > 0, 'Provide at least one field to change');
type GatewayChanges = z.output<typeof GatewayChangesSchema>;

/** Whether a change touches what the gateway's kind serves it by: the kind itself, its protocols or its settings. */
function changesProvision(changes: GatewayChanges) {
  return changes.kind !== undefined || changes.protocols !== undefined || changes.settings !== undefined;
}

const gatewayColumns = {
  id: gateways.id,
  builtin: sql<boolean>`false`,
  name: gateways.name,
  kind: gateways.kind,
  networkId: gateways.networkId,
  protocols: gateways.protocols,
  settings: gateways.settings,
  createdAt: gateways.createdAt
};

// An organisation's gateways, in the principal's request session: members read them, administrators manage them. A
// gateway's network must belong to the same organisation, which the database's composite foreign key enforces. The
// built-in gateways (src/gateways/index.ts) are listed and read beside them, but never changed.
export default new Hono()
  .get(
    '/',
    describeRoute({
      operationId: 'organisations.gateways.list',
      ...operationVersion(1),
      summary: "List an organisation's gateways",
      description:
        "The built-in gateways, then the organisation's own (none for organisations you are not a member of). Optionally only those on one network, which no built-in gateway is.",
      responses: {
        200: { description: 'The built-in gateways, then the organisation’s own, oldest first' },
        400: invalidRequest,
        401: unauthenticated,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', OrganisationParamsSchema),
    validator('query', z.object({ networkId: z.uuid().optional().describe('Only gateways on this network.') })),
    async c => {
      const { id } = c.req.valid('param');
      const { networkId } = c.req.valid('query');
      const environment = useEnvironment();
      const principal = usePrincipal();
      const session = await environment.session(principal);
      const filter =
        networkId === undefined
          ? eq(gateways.organisationId, id)
          : and(eq(gateways.organisationId, id), eq(gateways.networkId, networkId));
      const rows = await session.transaction(tx =>
        tx.select(gatewayColumns).from(gateways).where(filter).orderBy(gateways.id)
      );
      const builtin = networkId === undefined ? builtinGateways : [];
      c.header('Cache-Control', 'no-store');
      return c.json({ gateways: [...builtin, ...rows] }, 200);
    }
  )
  .post(
    '/',
    describeRoute({
      operationId: 'organisations.gateways.create',
      ...operationVersion(1),
      summary: 'Add a gateway',
      description:
        'Administrators only. Somewhere streams are delivered to: on a network, or (`networkId` null) the internet, accepting the protocols it lists. A kind this API connects callers to (`mediamtx`) accepts only its own protocols, and the settings it reads.',
      responses: {
        201: { description: 'The new gateway' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        412: versionMismatch,
        422: invalidGateway,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', OrganisationParamsSchema),
    validator(
      'json',
      z.strictObject({
        name: GatewayNameSchema,
        kind: GatewayKindSchema,
        networkId: NetworkReferenceSchema.default(null),
        protocols: ProtocolsSchema,
        settings: SettingsSchema.default({})
      })
    ),
    async c => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const environment = useEnvironment();
      const principal = usePrincipal();
      const session = await environment.session(principal);
      const row = await session.transaction(async tx => {
        const [gateway] = await tx
          .insert(gateways)
          .values({
            organisationId: id,
            name: body.name,
            kind: body.kind,
            networkId: body.networkId,
            protocols: body.protocols,
            settings: body.settings
          })
          .returning(gatewayColumns);
        checkGatewayKind(gateway!.kind, gateway!.protocols, gateway!.settings);
        return gateway!;
      });
      c.header('Cache-Control', 'no-store');
      return c.json(row, 201);
    }
  )
  .get(
    '/:gatewayId',
    describeRoute({
      operationId: 'organisations.gateways.get',
      ...operationVersion(1),
      summary: 'Read a gateway',
      description: "A built-in gateway, or one of the organisation's own.",
      responses: {
        200: { description: 'The gateway' },
        400: invalidRequest,
        401: unauthenticated,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', GatewayParamsSchema),
    async c => {
      const { id, gatewayId } = c.req.valid('param');
      c.header('Cache-Control', 'no-store');
      if (isBuiltinGateway(gatewayId))
        return c.json(
          builtinGateways.find(gateway => gateway.id === gatewayId)!,
          200
        );
      const environment = useEnvironment();
      const principal = usePrincipal();
      const session = await environment.session(principal);
      const [row] = await session.transaction(tx =>
        tx
          .select(gatewayColumns)
          .from(gateways)
          .where(and(eq(gateways.organisationId, id), eq(gateways.id, gatewayId)))
      );
      if (!row) throw new ApiFailure('not_found');
      return c.json(row, 200);
    }
  )
  .patch(
    '/:gatewayId',
    describeRoute({
      operationId: 'organisations.gateways.update',
      ...operationVersion(1),
      summary: 'Update a gateway',
      description:
        'Administrators only, and never a built-in gateway. Changes only the fields given; `protocols` and `settings` are replaced whole. Refused if an exposure uses a protocol it would no longer accept.',
      responses: {
        200: { description: 'The updated gateway' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        409: inUse,
        412: versionMismatch,
        422: invalidGateway,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', GatewayParamsSchema),
    validator('json', GatewayChangesSchema),
    async c => {
      const { id, gatewayId } = c.req.valid('param');
      const body = c.req.valid('json');
      if (isBuiltinGateway(gatewayId)) throw new ApiFailure('forbidden');
      const environment = useEnvironment();
      const principal = usePrincipal();
      const session = await environment.session(principal);
      const row = await session.transaction(async tx => {
        const [gateway] = await tx
          .update(gateways)
          .set({
            name: body.name,
            kind: body.kind,
            networkId: body.networkId,
            protocols: body.protocols,
            settings: body.settings
          })
          .where(and(eq(gateways.organisationId, id), eq(gateways.id, gatewayId)))
          .returning(gatewayColumns);
        if (!gateway) throw await unchanged(tx, gateways.id, gatewayId);
        if (body.protocols !== undefined) await checkProtocolsInUse(tx, gatewayId, body.protocols);
        if (changesProvision(body)) checkGatewayKind(gateway.kind, gateway.protocols, gateway.settings);
        return gateway;
      });
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .delete(
    '/:gatewayId',
    describeRoute({
      operationId: 'organisations.gateways.delete',
      ...operationVersion(1),
      summary: 'Remove a gateway',
      description: 'Administrators only, and never a built-in gateway. Refused while exposures use it.',
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
    validator('param', GatewayParamsSchema),
    async c => {
      const { id, gatewayId } = c.req.valid('param');
      if (isBuiltinGateway(gatewayId)) throw new ApiFailure('forbidden');
      const environment = useEnvironment();
      const principal = usePrincipal();
      const session = await environment.session(principal);
      await session.transaction(async tx => {
        const deleted = await tx
          .delete(gateways)
          .where(and(eq(gateways.organisationId, id), eq(gateways.id, gatewayId)))
          .returning({ id: gateways.id });
        if (deleted.length === 0) throw await unchanged(tx, gateways.id, gatewayId);
        await checkGatewayUnused(tx, gatewayId);
      });
      return c.body(null, 204);
    }
  );
