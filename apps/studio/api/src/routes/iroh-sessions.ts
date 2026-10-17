import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { requireDevice, useDevice } from '../middleware/device.ts';
import { irohSession } from '../topology/iroh.ts';
import { invalidSignature, operationVersion, unavailable, versionMismatch } from './openapi.ts';

// The start of every device's iroh session (src/topology/iroh.ts), signed by the device's own identity
// (src/middleware/device.ts) with no account session: agents ask before serving, the CLI before dialling.
export default new Hono().post(
  '/',
  describeRoute({
    operationId: 'irohSessions.create',
    ...operationVersion(1),
    summary: 'Start an iroh session',
    description:
      "How the signing device's iroh endpoint connects: n0's public relays, or its organisation's own, each with any token it needs. Asked for each time the device binds an endpoint, and not kept. Any device: the request carries an RFC 9421 HTTP Message Signature by the device's Ed25519 identity, as for `reports.submit`, over an empty body.",
    responses: {
      200: { description: 'The relays to use' },
      401: invalidSignature,
      412: versionMismatch,
      503: unavailable
    }
  }),
  requireDevice,
  c => {
    const device = useDevice();
    const session = irohSession(device);
    c.header('Cache-Control', 'no-store');
    return c.json(session, 200);
  }
);
