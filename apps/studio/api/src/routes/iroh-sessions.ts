import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { requireDevice, useDevice } from '../middleware/device.ts';
import { irohSession } from '../topology/iroh.ts';
import { endpointRefused, invalidSignature, leaseUnavailable, operationVersion, versionMismatch } from './openapi.ts';

// The start of every device's iroh session (src/topology/iroh.ts), signed by the device's own identity
// (src/middleware/device.ts) with no account session: agents ask before serving, the CLI before dialling.
export default new Hono().post(
  '/',
  describeRoute({
    operationId: 'irohSessions.create',
    ...operationVersion(1),
    summary: 'Start an iroh session',
    description:
      "The relay the signing device's iroh endpoint uses, with any token it needs, and the lease admitting the endpoint to it when the relay requires one. Every device gets the same relay, so a device is reached at its endpoint ID on that relay, with no address lookup. Asked for each time the device binds an endpoint, and again before its lease expires: the relay refuses new connections after that. Any device: the request carries an RFC 9421 HTTP Message Signature by the device's Ed25519 identity, as for `reports.submit`, over an empty body.",
    responses: {
      200: { description: 'The relay to use' },
      401: invalidSignature,
      403: endpointRefused,
      412: versionMismatch,
      503: leaseUnavailable
    }
  }),
  requireDevice,
  async c => {
    const device = useDevice();
    const session = await irohSession(device);
    c.header('Cache-Control', 'no-store');
    return c.json(session, 200);
  }
);
