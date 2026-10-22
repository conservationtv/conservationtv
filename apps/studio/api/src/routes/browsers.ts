import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { trustedTransaction } from '../db/transaction.ts';
import { ApiFailure } from '../errors.ts';
import { requirePrincipal, useAuthSession, useUser } from '../middleware/principal.ts';
import { createBrowser, getSessionBrowser, lockSessionBrowser, sessionBrowserName } from '../services/browsers.ts';
import { createDevice } from '../services/devices.ts';
import { getMembership } from '../services/organisations.ts';
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

// The signed-in browser's own device in an organisation (src/services/browsers.ts), made on first asking: trusted code,
// since it is returned with its private key, for members only.
export default new Hono().put(
  '/',
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
    const principal = useUser();
    const sessionId = useAuthSession();
    const browser = await trustedTransaction(async () => {
      await lockSessionBrowser(id, sessionId);
      const membership = await getMembership(id, principal.id);
      if (!membership) throw new ApiFailure('not_found');
      const existing = await getSessionBrowser(id, sessionId);
      if (existing) return existing;
      const name = await sessionBrowserName(sessionId);
      const device = await createDevice(id, { kind: 'browser', name, networkId: null });
      await createBrowser(id, device.id, { userId: principal.id, sessionId });
      const created = await getSessionBrowser(id, sessionId);
      return created!;
    });
    const privateKey = Buffer.from(browser.privateKey).toString('base64url');
    c.header('Cache-Control', 'no-store');
    return c.json({ ...browser, privateKey }, 200);
  }
);
