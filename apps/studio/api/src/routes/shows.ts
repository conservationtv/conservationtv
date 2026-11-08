import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { transaction } from '../db/transaction.ts';
import { useEnvironment } from '../env/env.ts';
import { ApiFailure } from '../errors.ts';
import { requirePrincipal } from '../middleware/principal.ts';
import { getOrganisation } from '../services/organisations.ts';
import { broadcastBundle, broadcastServe, shuffledComposition } from '../shows/broadcast.ts';
import { validator } from './openapi.ts';

const OrganisationParamsSchema = z.object({ id: z.uuid().describe('The organisation.') });
export type OrganisationParams = z.output<typeof OrganisationParamsSchema>;

// An organisation's broadcast, followed as a vignette stream over a WebSocket (src/shows/host.ts). Not operations of
// the versioned API: a browser cannot send the handshake's headers with a WebSocket, so the routes are hidden, as
// Better Auth's are. Members follow it, signed in by their session cookie. Following it changes nothing; only setting
// its composition does, which for now is a temporary command that composes it from the organisation's streams.
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

export default new Hono()
  .get('/', describeRoute({ hide: true }), requirePrincipal, validator('param', OrganisationParamsSchema), async c => {
    const { id } = c.req.valid('param');
    if (c.req.header('Upgrade') !== 'websocket') return c.text('Expected a WebSocket', 426);
    const origin = c.req.header('Origin');
    await transaction(() => requireMember(origin, id));
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
  );
