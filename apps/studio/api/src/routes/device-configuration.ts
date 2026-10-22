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
      "What the signing device runs, derived from the topology whenever it asks. `state` is `idle` for a device that runs nothing: an agent that is not its network's active agent, or whose network has no MediaMTX gateway. It is `active` for a network's active agent, with the MediaMTX gateway on its network (and how it checks readers' tokens), the MediaMTX `paths` it serves, each delivering one rendition of an exposure from a `source` that is a URL to pull while it is read (a camera's, credentials included) or another of its paths, and the `publishers` it runs, each publishing an exposure by MoQ in the `layout` its gateway takes, reading each rendition from one of its paths, with the `connect` ask for where to publish and the token to do so. `diagnostics` says what the topology asks for that the configuration leaves out, and why. Any device: the request carries an RFC 9421 HTTP Message Signature by the device's Ed25519 identity, as for `reports.submit`, over an empty body.",
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
