import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { transaction } from '../db/transaction.ts';
import { connectStats } from '../gateways/connect.ts';
import { ApiFailure } from '../errors.ts';
import { BUILTIN_GATEWAY_IDS, builtinGateways, GATEWAY_KIND_IDS, isBuiltinGateway } from '../gateways/index.ts';
import { requirePrincipal } from '../middleware/principal.ts';
import { listGatewayEndpoints } from '../services/gateway-endpoints.ts';
import { createGateway, deleteGateway, getGateway, listGateways, updateGateway } from '../services/gateways.ts';
import { NetworkReferenceSchema, SettingsSchema } from '../topology/settings.ts';
import {
  forbidden,
  gatewayUnavailable,
  inUse,
  invalidGateway,
  invalidRequest,
  noCaller,
  notFound,
  operationVersion,
  unauthenticated,
  unavailable,
  unsupportedStats,
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
const GatewayKindSchema = z.enum(GATEWAY_KIND_IDS).describe('The gateway implementation, such as `mediamtx`.');
export type GatewayKind = z.output<typeof GatewayKindSchema>;

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
        "The built-in gateways, then the organisation's own (none for organisations you are not a member of). Optionally only those on one network, which no built-in gateway is. Each of the organisation's own has `tls`: the hostname it is reached at on its network, where that points, and its certificate's issue and expiry, with the last attempt to issue one and why it failed; null until the deployment gives it a hostname (`GATEWAY_DOMAIN`), which happens when the agent running it next asks for its configuration.",
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
      const filter = c.req.valid('query');
      const rows = await transaction(() => listGateways(id, filter));
      // No built-in gateway is on a network.
      const builtin = filter.networkId === undefined ? builtinGateways : [];
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
        'Administrators only. Somewhere streams are delivered to: on a network, or (`networkId` null) the internet. Its `kind` decides the protocols it is published to and read by, and the `settings` it is registered with.',
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
        settings: SettingsSchema.default({})
      })
    ),
    async c => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const row = await transaction(() => createGateway(id, body));
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
      description:
        "A built-in gateway, or one of the organisation's own, with its hostname and certificate (`tls`) as `organisations.gateways.list` has them.",
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
      const row = await transaction(() => getGateway(id, gatewayId));
      if (!row) throw new ApiFailure('not_found');
      return c.json(row, 200);
    }
  )
  .get(
    '/:gatewayId/endpoints',
    describeRoute({
      operationId: 'organisations.gateways.listEndpoints',
      ...operationVersion(1),
      summary: "List where a gateway's servers are reached",
      description:
        "One base URL per protocol, as the agent running the gateway registered them (`gatewayEndpoints.replace`) from what its MediaMTX actually listens on, by protocol. Only the network's active agent's count, and only until they expire, which they do soon after it stops. An exposure's rendition is served under each at `<exposure>/<rendition>`. Empty while no agent runs the gateway, and for a built-in gateway, which registers none.",
      responses: {
        200: { description: 'The endpoints, by protocol' },
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
      if (isBuiltinGateway(gatewayId)) return c.json({ endpoints: [] }, 200);
      const endpoints = await transaction(async () => {
        const gateway = await getGateway(id, gatewayId);
        if (!gateway) throw new ApiFailure('not_found');
        return listGatewayEndpoints(id, gatewayId);
      });
      return c.json({ endpoints }, 200);
    }
  )
  .patch(
    '/:gatewayId',
    describeRoute({
      operationId: 'organisations.gateways.update',
      ...operationVersion(1),
      summary: 'Update a gateway',
      description:
        'Administrators only, and never a built-in gateway. Changes only the fields given; `settings` are replaced whole, and checked against its kind.',
      responses: {
        200: { description: 'The updated gateway' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        412: versionMismatch,
        422: invalidGateway,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', GatewayParamsSchema),
    validator(
      'json',
      z
        .strictObject({
          name: GatewayNameSchema.optional(),
          kind: GatewayKindSchema.optional(),
          networkId: NetworkReferenceSchema.optional(),
          settings: SettingsSchema.optional()
        })
        .refine(changes => Object.keys(changes).length > 0, 'Provide at least one field to change')
    ),
    async c => {
      const { id, gatewayId } = c.req.valid('param');
      const body = c.req.valid('json');
      if (isBuiltinGateway(gatewayId)) throw new ApiFailure('forbidden');
      const row = await transaction(() => updateGateway(id, gatewayId, body));
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
      description:
        'Administrators only, and never a built-in gateway. Refused while exposures or show previews use it.',
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
      await transaction(() => deleteGateway(id, gatewayId));
      return c.body(null, 204);
    }
  )
  .post(
    '/:gatewayId/stats',
    describeRoute({
      operationId: 'organisations.gateways.stats.connect',
      ...operationVersion(1),
      summary: "Read a gateway's traffic stats",
      description:
        "Where to read what the gateway's relays carry of the organisation's broadcasts, with the short-lived, read-only credential that admits the caller there: dial `relay` at `path`, presenting `token` as the URL's `jwt` query parameter. Each relay node announces a broadcast beneath it, `node/<node>`, whose `subscriber.json` track holds what the node received and `publisher.json` what it sent, each a JSON object of cumulative counters (`bytes`, `frames`, `broadcasts_started`, `broadcasts_ended`, …) by broadcast path. Ask again before `expiresAt`. Only built-in MoQ relays publish stats. Members read, signed in, and the organisation's devices with an RFC 9421 HTTP Message Signature by their own identity.",
      responses: {
        200: { description: 'Where to read the stats' },
        400: invalidRequest,
        401: noCaller,
        404: notFound,
        412: versionMismatch,
        422: unsupportedStats,
        503: gatewayUnavailable
      }
    }),
    requirePrincipal,
    validator('param', GatewayParamsSchema),
    async c => {
      const { id, gatewayId } = c.req.valid('param');
      const connection = await connectStats(id, gatewayId);
      c.header('Cache-Control', 'no-store');
      return c.json(connection, 200);
    }
  );
