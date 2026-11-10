import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { transaction, trustedTransaction } from '../db/transaction.ts';
import { useEnvironment } from '../env/env.ts';
import { ApiFailure } from '../errors.ts';
import { useDevice } from '../middleware/device.ts';
import { requirePrincipal, usePrincipal } from '../middleware/principal.ts';
import { getOrganisation } from '../services/organisations.ts';
import {
  deleteShowOutput,
  getShowOutput,
  selectOutputShow,
  setShowOutput,
  syncBroadcasters
} from '../services/shows.ts';
import { broadcastBundle, broadcastServe, shuffledComposition } from '../shows/broadcast.ts';
import {
  forbidden,
  invalidReference,
  invalidRequest,
  notFound,
  unauthenticated,
  unavailable,
  validator,
  webSocket
} from './openapi.ts';

const OrganisationParamsSchema = z.object({ id: z.uuid().describe('The organisation.') });
export type OrganisationParams = z.output<typeof OrganisationParamsSchema>;
const OutputDeviceSchema = z.uuid().describe("The agent that drives OBS for the broadcast: one of the organisation's.");
export type OutputDevice = z.output<typeof OutputDeviceSchema>;

// An organisation's broadcast (src/shows), which every one of its shows follows for now. It is followed as a vignette
// stream over a WebSocket (src/shows/host.tsx), by members signed in by their session cookie and by the agents its
// shows go out through, signed as their devices. Following it changes nothing; only setting its composition does, which
// for now is a temporary command composing it from the organisation's streams. Both are versionless operations:
// following is a WebSocket, which the SDK gives the address of (`webSocket`), and composing will give way to a show's
// controls. Where it goes out is versionless too, so it stays out of the released contract: it is kept for the show
// whose ID is the organisation's, which every organisation going out before it could have more than one show has,
// until the per-show operations (src/routes/shows.ts) replace it.
// A frame page (packages/shows' `*.frame.tsx`, as OBS or an iframe opens it) follows its own source over a WebSocket
// too, with no session at all, so that socket serves frame sources only (src/shows/host.tsx). The show's bundle names
// that address (src/shows/broadcast.ts), so it is no operation: its route is hidden.
// The broadcast's object does not run under row-level security, so the routes that reach it for a member first read
// the organisation as the caller: members of other organisations get `not_found`.
// Cross-site requests are left to Better Auth's session cookie, which is `SameSite=Lax`: no other site's page can send
// it with a WebSocket handshake or a POST. Same-site pages can, and a WebSocket has no CORS to keep them from reading
// it, so this relies on every host under conservation.tv being ours, gateways' included.

/** Refuse any device but those the organisation's shows go out through (`not_found`), as trusted code. */
async function requireOutput(organisationId: string) {
  const device = useDevice();
  const output = await trustedTransaction(() => selectOutputShow(device.id));
  if (output?.organisationId !== organisationId) throw new ApiFailure('not_found');
}

export default new Hono()
  .get(
    '/',
    describeRoute({
      operationId: 'organisations.show.follow',
      ...webSocket(),
      summary: "Follow the organisation's broadcast",
      description:
        "A WebSocket, sent the broadcast as a vignette stream: its setup and latest update first, then each update as it is composed. Followed by the organisation's members, and by the agent it goes out through, signed as its device. Refused until the broadcast has been composed.",
      responses: {
        101: { description: 'Following the broadcast' },
        400: invalidRequest,
        401: unauthenticated,
        404: notFound,
        426: { description: 'The request is not a WebSocket handshake' },
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', OrganisationParamsSchema),
    async c => {
      const { id } = c.req.valid('param');
      if (c.req.header('Upgrade') !== 'websocket') return c.text('Expected a WebSocket', 426);
      const principal = usePrincipal();
      if (principal.kind === 'device') {
        await requireOutput(id);
      } else {
        const organisation = await transaction(() => getOrganisation(id));
        if (!organisation) throw new ApiFailure('not_found');
      }
      const environment = useEnvironment();
      const broadcast = environment.broadcasts.get(id);
      return broadcast.fetch(c.req.raw);
    }
  )
  .get('/stream', describeRoute({ hide: true }), validator('param', OrganisationParamsSchema), async c => {
    const { id } = c.req.valid('param');
    if (c.req.header('Upgrade') !== 'websocket') return c.text('Expected a WebSocket', 426);
    const environment = useEnvironment();
    const broadcast = environment.broadcasts.get(id);
    return broadcast.fetch(c.req.raw);
  })
  // Temporary, until a show has controls.
  .post(
    '/compose',
    describeRoute({
      operationId: 'organisations.show.compose',
      summary: "Compose the organisation's broadcast",
      description:
        "Composes the broadcast from the organisation's streams, as the caller sees them, in a random order. Everyone following it is sent the result as its next update. Temporary, until a show has controls.",
      responses: {
        204: { description: 'Composed' },
        400: invalidRequest,
        401: unauthenticated,
        404: notFound,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', OrganisationParamsSchema),
    async c => {
      const { id } = c.req.valid('param');
      const state = await transaction(async () => {
        const organisation = await getOrganisation(id);
        if (!organisation) throw new ApiFailure('not_found');
        return shuffledComposition(id);
      });
      const environment = useEnvironment();
      const bundle = await broadcastBundle(environment.assets, environment.variables.APP_URL);
      const serve = broadcastServe(id, environment.variables.APP_URL);
      const broadcast = environment.broadcasts.get(id);
      await broadcast.setComposition({ state, ...bundle, serve });
      return c.body(null, 204);
    }
  )
  .get(
    '/output',
    describeRoute({
      operationId: 'organisations.show.output.get',
      summary: "Read where an organisation's broadcast goes out",
      description: 'The agent that drives OBS for it, following the broadcast and playing its streams.',
      responses: {
        200: { description: 'The output' },
        400: invalidRequest,
        401: unauthenticated,
        404: notFound,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', OrganisationParamsSchema),
    async c => {
      const { id } = c.req.valid('param');
      const row = await transaction(() => getShowOutput(id, id));
      if (!row) throw new ApiFailure('not_found');
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .put(
    '/output',
    describeRoute({
      operationId: 'organisations.show.output.set',
      summary: "Set where an organisation's broadcast goes out",
      description:
        "Administrators only. The agent, one of the organisation's, drives OBS for the broadcast in place of any other: its configuration gains the `obs` runtime, and it follows the broadcast and reads the streams it shows. OBS agents run on Windows and macOS.",
      responses: {
        200: { description: 'The output' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        422: invalidReference,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', OrganisationParamsSchema),
    validator('json', z.strictObject({ deviceId: OutputDeviceSchema })),
    async c => {
      const { id } = c.req.valid('param');
      const { deviceId } = c.req.valid('json');
      const row = await transaction(() => setShowOutput(id, id, deviceId));
      await trustedTransaction(() => syncBroadcasters(id));
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .delete(
    '/output',
    describeRoute({
      operationId: 'organisations.show.output.delete',
      summary: "Stop an organisation's broadcast going out",
      description: 'Administrators only. Its agent stops running OBS for it.',
      responses: {
        204: { description: 'Stopped' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', OrganisationParamsSchema),
    async c => {
      const { id } = c.req.valid('param');
      await transaction(() => deleteShowOutput(id, id));
      await trustedTransaction(() => syncBroadcasters(id));
      return c.body(null, 204);
    }
  );
