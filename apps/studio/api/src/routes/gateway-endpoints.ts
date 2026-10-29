import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { trustedTransaction } from '../db/transaction.ts';
import { requireDevice, useDevice } from '../middleware/device.ts';
import {
  ENDPOINT_LEASE_MS,
  RegisteredEndpointsSchema,
  replaceGatewayEndpoints
} from '../services/gateway-endpoints.ts';
import {
  conflict,
  invalidRequest,
  invalidSignature,
  operationVersion,
  unavailable,
  validator,
  versionMismatch
} from './openapi.ts';

// Where the gateway the signing agent runs is reached (src/services/gateway-endpoints.ts). Agents register it signed,
// as they do for `deviceAddresses.replace`, once their MediaMTX is serving, renew it while it runs, and withdraw it on
// stopping.
export default new Hono().put(
  '/',
  describeRoute({
    operationId: 'gatewayEndpoints.replace',
    ...operationVersion(1),
    summary: "Replace the endpoints of the signing agent's gateway",
    description: `Where each protocol's server of the MediaMTX gateway the signing agent runs is reached, as its MediaMTX actually listens: one base URL per protocol, whose scheme is the protocol's (\`http\` or \`https\` for HLS and WebRTC). They replace whatever it registered before, whole, and hold for ${ENDPOINT_LEASE_MS / 60_000} minutes unless registered again, which agents do while they run. \`connect\` builds its URLs from them, and members read them with \`organisations.gateways.listEndpoints\`. Refused, as \`conflict\`, unless the agent is the active agent on the gateway's network. An empty list withdraws them, always accepted. Any device: the request carries an RFC 9421 HTTP Message Signature by the device's Ed25519 identity, as for \`reports.submit\`.`,
    responses: {
      200: { description: 'The endpoints as stored, with when they expire' },
      400: invalidRequest,
      401: invalidSignature,
      409: conflict,
      412: versionMismatch,
      503: unavailable
    }
  }),
  requireDevice,
  validator('json', RegisteredEndpointsSchema),
  async c => {
    const registration = c.req.valid('json');
    const device = useDevice();
    const endpoints = await trustedTransaction(() => replaceGatewayEndpoints(device, registration));
    c.header('Cache-Control', 'no-store');
    return c.json({ endpoints }, 200);
  }
);
