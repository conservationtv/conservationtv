import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { planConfiguration } from '../configuration/plan/index.ts';
import { requireDevice, useDevice } from '../middleware/device.ts';
import { invalidSignature, operationVersion, unavailable, versionMismatch } from './openapi.ts';

// What the signing device should be doing, derived from the topology now (src/configuration/plan/index.ts). Devices ask
// for it signed, as they do for `iroh-sessions`, and again whenever they want to notice a change.
export default new Hono().get(
  '/',
  describeRoute({
    operationId: 'deviceConfiguration.get',
    ...operationVersion(1),
    summary: "Read the signing device's configuration",
    description:
      "What the signing device delivers, derived from the topology whenever it asks: for a network's active agent, the MediaMTX gateway on its network (and how it checks readers' tokens), each exposure of that gateway with the MediaMTX path each rendition is served at and where to pull it from, credentials included, and each exposure it publishes by MoQ with the path each rendition is read from. `diagnostics` says what the topology asks for that the configuration leaves out, and why. Any device: the request carries an RFC 9421 HTTP Message Signature by the device's Ed25519 identity, as for `reports.submit`, over an empty body.",
    responses: {
      200: { description: 'The configuration' },
      401: invalidSignature,
      412: versionMismatch,
      503: unavailable
    }
  }),
  requireDevice,
  async c => {
    const device = useDevice();
    const configuration = await planConfiguration(device);
    c.header('Cache-Control', 'no-store');
    return c.json(configuration, 200);
  }
);
