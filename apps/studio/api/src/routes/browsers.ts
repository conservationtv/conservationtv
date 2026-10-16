import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { requirePrincipal, useAuthSession, usePrincipal } from '../middleware/principal.ts';
import { ensureBrowser } from '../topology/browsers.ts';
import {
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

// The signed-in browser's own device in an organisation (src/topology/browsers.ts).
export default new Hono().put(
  '/:id/browser',
  describeRoute({
    operationId: 'organisations.browser.ensure',
    ...operationVersion(1),
    summary: "Get or create this session's browser device",
    description:
      'Members only. One per auth session and organisation, created on the first request, on the internet, for iroh connections through a relay. Returned with its private key (the raw 32-byte Ed25519 seed, unpadded base64url), so the browser can act as it. It is removed when the session ends or the account leaves the organisation.',
    responses: {
      200: { description: 'The browser device, with its private key' },
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
    const principal = usePrincipal();
    const sessionId = useAuthSession();
    const browser = await ensureBrowser(principal, sessionId, id);
    const privateKey = Buffer.from(browser.privateKey).toString('base64url');
    c.header('Cache-Control', 'no-store');
    return c.json({ ...browser, privateKey }, 200);
  }
);
