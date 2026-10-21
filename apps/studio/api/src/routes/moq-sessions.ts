import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { requireDevice, useDevice } from '../middleware/device.ts';
import { moqSession } from '../topology/moq.ts';
import {
  invalidRequest,
  invalidSignature,
  notFound,
  operationVersion,
  tokenUnavailable,
  validator,
  versionMismatch
} from './openapi.ts';

// The start of a device's MoQ session (src/topology/moq.ts), when it delivers an exposure itself, signed by the
// device's own identity (src/middleware/device.ts) with no account session.
export default new Hono().post(
  '/',
  describeRoute({
    operationId: 'moqSessions.create',
    ...operationVersion(1),
    summary: 'Start a MoQ session',
    description:
      "The relay to publish an exposure's broadcast to, and the token admitting the signing device to publish it, for a device that delivers the exposure itself rather than through an agent. Only the source device of the exposure's stream, and only for a `moq` exposure. Asked for each time the device connects: the relay refuses new sessions once the token expires. Any device: the request carries an RFC 9421 HTTP Message Signature by the device's Ed25519 identity, as for `reports.submit`.",
    responses: {
      200: { description: 'The relay, broadcast and token' },
      400: invalidRequest,
      401: invalidSignature,
      404: notFound,
      412: versionMismatch,
      503: tokenUnavailable
    }
  }),
  requireDevice,
  validator('json', z.strictObject({ exposureId: z.uuid().describe('The exposure to publish.') })),
  async c => {
    const device = useDevice();
    const { exposureId } = c.req.valid('json');
    const session = await moqSession(device, exposureId);
    c.header('Cache-Control', 'no-store');
    return c.json(session, 200);
  }
);
