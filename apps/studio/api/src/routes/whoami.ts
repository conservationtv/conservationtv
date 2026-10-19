import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { requireDevice, useDevice } from '../middleware/device.ts';
import type { DeviceKind } from '../topology/device-kinds.ts';
import { invalidSignature, operationVersion, versionMismatch } from './openapi.ts';

/** The signing device, as the topology names it. */
export interface Whoami {
  /** Its ID: what reports name it by, as `device:<id>`, and for an agent or a camera `<kind>:<id>` too. */
  id: string;
  organisationId: string;
  kind: DeviceKind;
  /** Its iroh endpoint ID. */
  publicId: string;
}

// Who the signing device is. A device knows only its key, so it asks this, signed (src/middleware/device.ts), for the
// IDs reports and the topology name it by.
export default new Hono().get(
  '/',
  describeRoute({
    operationId: 'whoami.get',
    ...operationVersion(1),
    summary: 'Read the signing device',
    description:
      "The signing device's ID, organisation and kind: a device holds only its key, so it asks for the ID it reports " +
      "about itself as. Any device: the request carries an RFC 9421 HTTP Message Signature by the device's Ed25519 " +
      'identity, as for `reports.submit`, over an empty body.',
    responses: {
      200: { description: 'The signing device' },
      401: invalidSignature,
      412: versionMismatch
    }
  }),
  requireDevice,
  async c => {
    const device = useDevice();
    const signed: Whoami = {
      id: device.id,
      organisationId: device.organisationId,
      kind: device.kind,
      publicId: device.publicId
    };
    c.header('Cache-Control', 'no-store');
    return c.json(signed, 200);
  }
);
