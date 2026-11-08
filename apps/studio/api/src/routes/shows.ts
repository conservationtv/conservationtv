import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { transaction } from '../db/transaction.ts';
import { useEnvironment } from '../env/env.ts';
import { ApiFailure } from '../errors.ts';
import { requirePrincipal } from '../middleware/principal.ts';
import { getOrganisation } from '../services/organisations.ts';
import { broadcastBundle, broadcastServe, shuffledComposition } from '../shows/broadcast.ts';
import { invalidRequest, notFound, unauthenticated, unavailable, validator, webSocket } from './openapi.ts';

const OrganisationParamsSchema = z.object({ id: z.uuid().describe('The organisation.') });
export type OrganisationParams = z.output<typeof OrganisationParamsSchema>;

// An organisation's broadcast, followed as a vignette stream over a WebSocket (src/shows/host.tsx). Members follow it,
// signed in by their session cookie. Following it changes nothing; only setting its composition does, which for now is
// a temporary command that composes it from the organisation's streams. Both are versionless operations: following is
// a WebSocket, which the SDK gives the address of (`webSocket`), and composing will give way to a show's controls.
// A frame page (packages/shows' `*.frame.tsx`, as OBS or an iframe opens it) follows its own source over a WebSocket
// too, with no session at all, so that socket serves frame sources only (src/shows/host.tsx). The show's bundle names
// that address (src/shows/broadcast.ts), so it is no operation: its route is hidden.
// The broadcast's object does not run under row-level security, so the routes that reach it for a member first read
// the organisation as the caller: members of other organisations get `not_found`.
// Cross-site requests are left to Better Auth's session cookie, which is `SameSite=Lax`: no other site's page can send
// it with a WebSocket handshake or a POST. Same-site pages can, and a WebSocket has no CORS to keep them from reading
// it, so this relies on every host under conservation.tv being ours, gateways' included.

export default new Hono()
  .get(
    '/',
    describeRoute({
      operationId: 'organisations.show.follow',
      ...webSocket(),
      summary: "Follow the organisation's broadcast",
      description:
        'A WebSocket, sent the broadcast as a vignette stream: its setup and latest update first, then each update as it is composed. Refused until the broadcast has been composed.',
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
      const organisation = await transaction(() => getOrganisation(id));
      if (!organisation) throw new ApiFailure('not_found');
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
  );
