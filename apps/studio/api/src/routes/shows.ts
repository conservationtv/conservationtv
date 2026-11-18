import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { transaction, trustedTransaction } from '../db/transaction.ts';
import { useEnvironment } from '../env/env.ts';
import { ApiFailure } from '../errors.ts';
import { useDevice } from '../middleware/device.ts';
import { requirePrincipal, usePrincipal } from '../middleware/principal.ts';
import { selectDeviceOutput } from '../services/outputs.ts';
import { createShow, deleteShow, getShow, listShows, showVisible, updateShow } from '../services/shows.ts';
import { broadcastBundle, broadcastServe, shuffledComposition } from '../shows/broadcast.ts';
import {
  forbidden,
  invalidRequest,
  notFound,
  operationVersion,
  unauthenticated,
  unavailable,
  validator,
  versionMismatch,
  webSocket
} from './openapi.ts';

const OrganisationParamsSchema = z.object({ id: z.uuid().describe('The organisation.') });
export type OrganisationParams = z.output<typeof OrganisationParamsSchema>;
const ShowParamsSchema = OrganisationParamsSchema.extend({ showId: z.uuid().describe('The show.') });
export type ShowParams = z.output<typeof ShowParamsSchema>;
const ShowNameSchema = z.string().trim().min(1).max(120).describe('What the show is called in the studio.');
export type ShowName = z.output<typeof ShowNameSchema>;

// An organisation's shows (src/services/shows.ts): what is on screen, each composed by an object of its own
// (src/shows/host.tsx, keyed by the show's ID). Members read them, administrators manage them. How a show goes out is
// each output's that follows it (src/routes/outputs.ts).
//
// A show is followed as a vignette stream over a WebSocket, by members signed in by their session cookie and by the
// agents of the outputs following it, signed as their devices. Following it changes nothing; only setting its
// composition does, which for now is a temporary command composing it from the organisation's streams. Both are
// versionless operations: following is a WebSocket, which the SDK gives the address of (`webSocket`), and composing
// will give way to a show's controls.
// A frame page (packages/shows' `*.frame.tsx`, as OBS or an iframe opens it) follows its own source over a WebSocket
// too, with no session at all, so that socket serves frame sources only (src/shows/host.tsx). The show's bundle names
// that address (src/shows/broadcast.ts), so it is no operation: its route is hidden.
// The show's object does not run under row-level security, so the routes that reach it for a member first read the
// show as the caller: members of other organisations get `not_found`.
// Cross-site requests are left to Better Auth's session cookie, which is `SameSite=Lax`: no other site's page can send
// it with a WebSocket handshake or a POST. Same-site pages can, and a WebSocket has no CORS to keep them from reading
// it, so this relies on every host under conservation.tv being ours, gateways' included.

/** Refuse any device but those of the outputs following the show (`not_found`), as trusted code. */
async function requireFollower(organisationId: string, showId: string) {
  const device = useDevice();
  const output = await trustedTransaction(() => selectDeviceOutput(device.id));
  if (output?.organisationId !== organisationId || output.showId !== showId) throw new ApiFailure('not_found');
}

/** Refuse a show the caller cannot see (`not_found`). */
async function requireShow(organisationId: string, showId: string) {
  const visible = await transaction(() => showVisible(organisationId, showId));
  if (!visible) throw new ApiFailure('not_found');
}

export default new Hono()
  .get(
    '/',
    describeRoute({
      operationId: 'organisations.shows.list',
      ...operationVersion(1),
      summary: "List an organisation's shows",
      description:
        'Each with the outputs following it, as `organisations.shows.get` reads one. Empty for organisations you are not a member of.',
      responses: {
        200: { description: 'The shows, oldest first' },
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
      const rows = await transaction(() => listShows(id));
      c.header('Cache-Control', 'no-store');
      return c.json({ shows: rows }, 200);
    }
  )
  .post(
    '/',
    describeRoute({
      operationId: 'organisations.shows.create',
      ...operationVersion(1),
      summary: 'Create a show',
      description:
        'Administrators only. It is on screen once it is composed, and goes out through each output that follows it (`organisations.outputs.update`).',
      responses: {
        201: { description: 'The new show' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', OrganisationParamsSchema),
    validator('json', z.strictObject({ name: ShowNameSchema })),
    async c => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const row = await transaction(() => createShow(id, body));
      c.header('Cache-Control', 'no-store');
      return c.json(row, 201);
    }
  )
  .get(
    '/:showId',
    describeRoute({
      operationId: 'organisations.shows.get',
      ...operationVersion(1),
      summary: 'Read a show',
      description: 'With the outputs following it.',
      responses: {
        200: { description: 'The show' },
        400: invalidRequest,
        401: unauthenticated,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', ShowParamsSchema),
    async c => {
      const { id, showId } = c.req.valid('param');
      const row = await transaction(() => getShow(id, showId));
      if (!row) throw new ApiFailure('not_found');
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .patch(
    '/:showId',
    describeRoute({
      operationId: 'organisations.shows.update',
      ...operationVersion(1),
      summary: 'Rename a show',
      description: 'Administrators only.',
      responses: {
        200: { description: 'The updated show, without its outputs' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', ShowParamsSchema),
    validator('json', z.strictObject({ name: ShowNameSchema })),
    async c => {
      const { id, showId } = c.req.valid('param');
      const body = c.req.valid('json');
      const row = await transaction(() => updateShow(id, showId, body));
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .delete(
    '/:showId',
    describeRoute({
      operationId: 'organisations.shows.delete',
      ...operationVersion(1),
      summary: 'Delete a show',
      description:
        'Administrators only. The outputs following it follow nothing until given another show: their OBS keeps streaming, with no scenes of the show.',
      responses: {
        204: { description: 'Deleted' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', ShowParamsSchema),
    async c => {
      const { id, showId } = c.req.valid('param');
      await transaction(() => deleteShow(id, showId));
      return c.body(null, 204);
    }
  )
  .get(
    '/:showId/follow',
    describeRoute({
      operationId: 'organisations.shows.follow',
      ...webSocket(),
      summary: 'Follow a show',
      description:
        "A WebSocket, sent the show as a vignette stream: its setup and latest update first, then each update as it is composed. Followed by the organisation's members, and by the agents of the outputs following it, signed as their devices. Refused until the show has been composed.",
      responses: {
        101: { description: 'Following the show' },
        400: invalidRequest,
        401: unauthenticated,
        404: notFound,
        426: { description: 'The request is not a WebSocket handshake' },
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', ShowParamsSchema),
    async c => {
      const { id, showId } = c.req.valid('param');
      if (c.req.header('Upgrade') !== 'websocket') return c.text('Expected a WebSocket', 426);
      const principal = usePrincipal();
      if (principal.kind === 'device') await requireFollower(id, showId);
      else await requireShow(id, showId);
      const environment = useEnvironment();
      const broadcast = environment.broadcasts.get(showId);
      return broadcast.fetch(c.req.raw);
    }
  )
  .get('/:showId/stream', describeRoute({ hide: true }), validator('param', ShowParamsSchema), async c => {
    const { showId } = c.req.valid('param');
    if (c.req.header('Upgrade') !== 'websocket') return c.text('Expected a WebSocket', 426);
    const environment = useEnvironment();
    const broadcast = environment.broadcasts.get(showId);
    return broadcast.fetch(c.req.raw);
  })
  // Temporary, until a show has controls.
  .post(
    '/:showId/compose',
    describeRoute({
      operationId: 'organisations.shows.compose',
      summary: 'Compose a show',
      description:
        "Composes the show from the organisation's streams, as the caller sees them, in a random order. Everyone following it is sent the result as its next update. Temporary, until a show has controls.",
      responses: {
        204: { description: 'Composed' },
        400: invalidRequest,
        401: unauthenticated,
        404: notFound,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', ShowParamsSchema),
    async c => {
      const { id, showId } = c.req.valid('param');
      const state = await transaction(async () => {
        if (!(await showVisible(id, showId))) throw new ApiFailure('not_found');
        return shuffledComposition(id);
      });
      const environment = useEnvironment();
      const bundle = await broadcastBundle(environment.assets, environment.variables.APP_URL);
      const serve = broadcastServe(id, showId, environment.variables.APP_URL);
      const broadcast = environment.broadcasts.get(showId);
      await broadcast.setComposition({ state, ...bundle, serve });
      return c.body(null, 204);
    }
  );
