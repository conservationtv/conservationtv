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
      "What the signing device runs, derived from the topology whenever it asks: a section for each runtime it is to run, and none for those it isn't. `mediamtx`, for a network's active agent on a network with a MediaMTX gateway: the gateway (and how it checks readers' tokens), the MediaMTX `paths` it serves, each delivering one rendition of an exposure from a `source` that is a URL to pull while it is read (a camera's, credentials included) or another of its paths, the `publishers` it runs, each publishing an exposure by MoQ in the `layout` its gateway takes, reading each rendition from one of its paths, with the `connect` ask for where to publish and the token to do so, and the `stats` asks (`organisations.gateways.stats.connect`) for the traffic stats of the gateways it publishes to that publish them. `obs`, for a show's output (`organisations.show.output.set`): the `show` it follows, at the `url` it signs a WebSocket upgrade to as the device, the `output` encoding the program is sent at, and the `forwards`, one for each of the organisation's enabled channels, with the `ingest` URL it reads the channel's server and stream key from (`organisations.channels.ingest`); it reads each stream the show places with `organisations.streams.exposures.connect`. A device with no section runs nothing. Any device: the request carries an RFC 9421 HTTP Message Signature by the device's Ed25519 identity, as for `reports.submit`, over an empty body.",
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
