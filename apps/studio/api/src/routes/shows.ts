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
  operationVersion,
  unauthenticated,
  unavailable,
  validator,
  versionMismatch
} from './openapi.ts';

const OrganisationParamsSchema = z.object({ id: z.uuid().describe('The organisation.') });
export type OrganisationParams = z.output<typeof OrganisationParamsSchema>;
const OutputDeviceSchema = z.uuid().describe("The agent that drives OBS for the broadcast: one of the organisation's.");
export type OutputDevice = z.output<typeof OutputDeviceSchema>;

// An organisation's broadcast (src/shows), its show for now: a show's ID is its organisation's. It is followed as a
// vignette stream over a WebSocket (src/shows/host.ts), by members signed in by their session cookie and by the agent
// it goes out through, signed as its device. Those routes are hidden, not operations of the versioned API: a browser
// cannot send the handshake's headers with a WebSocket. Following it changes nothing; only setting its composition
// does, which for now is a temporary command composing it from the organisation's streams. Where it goes out is an
// operation.
// A frame page (packages/shows' `*.frame.tsx`, as OBS or an iframe opens it) follows its own source over a WebSocket
// too, with no session at all, so that socket serves frame sources only (src/shows/host.ts).

/**
 * Refuse callers other than the studio's pages, and members of other organisations (`not_found`). A browser sends
 * cookies with a WebSocket from any page, and CORS does not apply to one. Runs in the request's transaction.
 */
async function requireMember(origin: string | undefined, organisationId: string) {
  const environment = useEnvironment();
  if (origin === undefined || !environment.variables.WEB_ORIGINS.includes(origin)) throw new ApiFailure('forbidden');
  const organisation = await getOrganisation(organisationId);
  if (!organisation) throw new ApiFailure('not_found');
}

/** Refuse any device but the one the show goes out through (`not_found`), as trusted code. */
async function requireOutput(showId: string) {
  const device = useDevice();
  const output = await trustedTransaction(() => selectOutputShow(device.id));
  if (output?.showId !== showId) throw new ApiFailure('not_found');
}

export default new Hono()
  .get('/', describeRoute({ hide: true }), requirePrincipal, validator('param', OrganisationParamsSchema), async c => {
    const { id } = c.req.valid('param');
    if (c.req.header('Upgrade') !== 'websocket') return c.text('Expected a WebSocket', 426);
    const principal = usePrincipal();
    const origin = c.req.header('Origin');
    if (principal.kind === 'device') await requireOutput(id);
    else await transaction(() => requireMember(origin, id));
    const environment = useEnvironment();
    const broadcast = environment.broadcasts.get(id);
    return broadcast.fetch(c.req.raw);
  })
  .get('/stream', describeRoute({ hide: true }), validator('param', OrganisationParamsSchema), async c => {
    const { id } = c.req.valid('param');
    if (c.req.header('Upgrade') !== 'websocket') return c.text('Expected a WebSocket', 426);
    const environment = useEnvironment();
    const broadcast = environment.broadcasts.get(id);
    return broadcast.fetch(c.req.raw);
  })
  // Temporary: composes the broadcast from the organisation's streams, as the caller sees them, in a random order.
  .post(
    '/compose',
    describeRoute({ hide: true }),
    requirePrincipal,
    validator('param', OrganisationParamsSchema),
    async c => {
      const { id } = c.req.valid('param');
      const origin = c.req.header('Origin');
      const state = await transaction(async () => {
        await requireMember(origin, id);
        return shuffledComposition(id);
      });
      const environment = useEnvironment();
      // The studio web app serves the show's bundle: the first of its origins is the app itself.
      const [webOrigin] = environment.variables.WEB_ORIGINS;
      const bundle = await broadcastBundle(webOrigin);
      const serve = broadcastServe(id, environment.variables.APP_URL, webOrigin);
      const broadcast = environment.broadcasts.get(id);
      await broadcast.setComposition({ state, ...bundle, serve });
      return c.body(null, 204);
    }
  )
  .get(
    '/output',
    describeRoute({
      operationId: 'organisations.show.output.get',
      ...operationVersion(1),
      summary: "Read where an organisation's broadcast goes out",
      description: 'The agent that drives OBS for it, following the broadcast and playing its streams.',
      responses: {
        200: { description: 'The output' },
        400: invalidRequest,
        401: unauthenticated,
        404: notFound,
        412: versionMismatch,
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
      ...operationVersion(1),
      summary: "Set where an organisation's broadcast goes out",
      description:
        "Administrators only. The agent, one of the organisation's, drives OBS for the broadcast in place of any other: its configuration gains the `obs` runtime, and it follows the broadcast and reads the streams it shows. OBS agents run on Windows and macOS.",
      responses: {
        200: { description: 'The output' },
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
      ...operationVersion(1),
      summary: "Stop an organisation's broadcast going out",
      description: 'Administrators only. Its agent stops running OBS for it.',
      responses: {
        204: { description: 'Stopped' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        412: versionMismatch,
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
