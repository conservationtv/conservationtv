import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { trustedTransaction } from '../db/transaction.ts';
import { requireDevice, useDevice } from '../middleware/device.ts';
import { MAX_DEVICE_ADDRESSES, ReportedAddressesSchema, replaceDeviceAddresses } from '../services/device-addresses.ts';
import {
  invalidRequest,
  invalidSignature,
  operationVersion,
  unavailable,
  validator,
  versionMismatch
} from './openapi.ts';

// Where the signing device says it can be reached on its own network (src/services/device-addresses.ts). Devices
// report it signed, as they do for `reports.submit`, whenever what they find on their interfaces changes.
export default new Hono().put(
  '/',
  describeRoute({
    operationId: 'deviceAddresses.replace',
    ...operationVersion(1),
    summary: "Replace the signing device's addresses",
    description: `The addresses the signing device can be reached at on its own network, as it finds them on its interfaces: at most ${MAX_DEVICE_ADDRESSES}, each once, at most one \`preferred\` (the one its default route leaves by). They replace whatever it reported before, whole: an empty list leaves it with none. Members read them with \`organisations.devices.listAddresses\`. Any device: the request carries an RFC 9421 HTTP Message Signature by the device's Ed25519 identity, as for \`reports.submit\`.`,
    responses: {
      200: { description: 'The addresses as stored' },
      400: invalidRequest,
      401: invalidSignature,
      412: versionMismatch,
      503: unavailable
    }
  }),
  requireDevice,
  validator('json', ReportedAddressesSchema),
  async c => {
    const reported = c.req.valid('json');
    const device = useDevice();
    const addresses = await trustedTransaction(() => replaceDeviceAddresses(device, reported));
    c.header('Cache-Control', 'no-store');
    return c.json({ addresses }, 200);
  }
);
