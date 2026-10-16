import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { describeRoute } from 'hono-openapi';
import { ApiFailure } from '../errors.ts';
import { requireDevice, useDevice } from '../middleware/device.ts';
import { BatchSchema, ingestBatch, MAX_BATCH_REPORTS } from '../reports/ingest.ts';
import {
  batchTooLarge,
  invalidRequest,
  invalidSignature,
  operationVersion,
  unavailable,
  validator,
  versionMismatch
} from './openapi.ts';

/** The largest batch accepted. */
const MAX_BATCH_BYTES = 1024 * 1024;

// Report ingestion. Devices call it with no session: each request is signed by the device's own identity
// (src/middleware/device.ts), and stored by trusted code (src/reports/ingest.ts).
export default new Hono().post(
  '/',
  describeRoute({
    operationId: 'reports.submit',
    ...operationVersion(1),
    summary: 'Submit a batch of reports',
    description: `Events (such as a heartbeat, or whether video is being received), metric samples and log messages, about any subjects, in one batch of at most ${MAX_BATCH_REPORTS} and 1 MiB. Any device: the request carries an RFC 9421 HTTP Message Signature by the device's Ed25519 identity, with its public ID as \`keyid\`, covering the method, URL, \`Content-Type\` and RFC 9530 \`Content-Digest\`, with \`created\`, \`expires\` and a single-use \`nonce\`. The batch is stored or refused whole. Reports are not deduplicated: a retry is signed again, and may be stored twice.`,
    responses: {
      202: { description: 'Accepted' },
      400: invalidRequest,
      401: invalidSignature,
      412: versionMismatch,
      413: batchTooLarge,
      503: unavailable
    }
  }),
  bodyLimit({
    maxSize: MAX_BATCH_BYTES,
    onError: () => {
      throw new ApiFailure('batch_too_large');
    }
  }),
  requireDevice,
  validator('json', BatchSchema),
  async c => {
    const batch = c.req.valid('json');
    const device = useDevice();
    const accepted = await ingestBatch(device, batch);
    c.header('Cache-Control', 'no-store');
    return c.json(accepted, 202);
  }
);
