import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { ApiFailure } from '../errors.ts';
import { requireDevice, useDevice } from '../middleware/device.ts';
import { BatchSchema, IdempotencyKeySchema, ingestBatch, MAX_BATCH_REPORTS } from '../reports/ingest.ts';
import {
  batchTooLarge,
  idempotencyKeyReused,
  invalidRequest,
  invalidSignature,
  notAnAgent,
  operationVersion,
  unavailable,
  validator,
  versionMismatch
} from './openapi.ts';

/** The largest batch accepted. */
const MAX_BATCH_BYTES = 1024 * 1024;

// Report ingestion. Agents call it with no session: each request is signed by the agent's own identity
// (src/middleware/device.ts), and stored by trusted code (src/reports/ingest.ts).
export default new Hono().post(
  '/',
  describeRoute({
    operationId: 'reports.submit',
    ...operationVersion(1),
    summary: 'Submit a batch of reports',
    description: `Events (such as a heartbeat, or whether video is being received), metric samples and log messages, about any subjects, in one batch of at most ${MAX_BATCH_REPORTS} and 1 MiB. Agents only: the request carries an RFC 9421 HTTP Message Signature by the agent's Ed25519 identity, with its public ID as \`keyid\`, covering the method, URL, \`Content-Type\`, RFC 9530 \`Content-Digest\` and \`Idempotency-Key\`, with \`created\`, \`expires\` and a single-use \`nonce\`. The batch is stored or refused whole. A retry with the same \`Idempotency-Key\` and body, within a day, returns the first result without storing the batch again; each retry needs a fresh signature.`,
    responses: {
      202: { description: 'Accepted' },
      400: invalidRequest,
      401: invalidSignature,
      403: notAnAgent,
      412: versionMismatch,
      413: batchTooLarge,
      422: idempotencyKeyReused,
      503: unavailable
    }
  }),
  bodyLimit({
    maxSize: MAX_BATCH_BYTES,
    onError: () => {
      throw new ApiFailure('batch_too_large');
    }
  }),
  requireDevice(['idempotency-key']),
  validator('header', z.object({ 'idempotency-key': IdempotencyKeySchema })),
  validator('json', BatchSchema),
  async c => {
    const headers = c.req.valid('header');
    const batch = c.req.valid('json');
    const device = useDevice();
    const body = await c.req.arrayBuffer();
    const accepted = await ingestBatch(device, headers['idempotency-key'], body, batch);
    c.header('Cache-Control', 'no-store');
    return c.json(accepted, 202);
  }
);
