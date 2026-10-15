import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { describeRoute } from 'hono-openapi';
import { ApiFailure } from '../errors.ts';
import { ingestBatch, MAX_BATCH_REPORTS, SubmissionSchema } from '../reports/ingest.ts';
import {
  batchTooLarge,
  invalidRequest,
  invalidSignature,
  operationVersion,
  unavailable,
  validator,
  versionMismatch
} from './openapi.ts';

/** The largest submission accepted, envelope included. */
const MAX_SUBMISSION_BYTES = 1024 * 1024;

// Report ingestion. Agents call it with no session: each batch is authenticated by its signature
// (src/reports/ingest.ts).
export default new Hono().post(
  '/',
  describeRoute({
    operationId: 'reports.submit',
    ...operationVersion(1),
    summary: 'Submit a batch of reports',
    description: `Events (such as a heartbeat, or whether video is being received), metric samples and log messages, about any subjects, in one batch of at most ${MAX_BATCH_REPORTS}. The \`batch\` is JSON text signed, byte for byte, by one of the reporting agent’s registered Ed25519 keys, and its \`reporterId\` must be that agent. The batch is stored or refused whole; reports are not deduplicated, so a retried batch may be stored twice. The submission, envelope included, may be at most 1 MiB.`,
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
    maxSize: MAX_SUBMISSION_BYTES,
    onError: () => {
      throw new ApiFailure('batch_too_large');
    }
  }),
  validator('json', SubmissionSchema),
  async c => {
    const accepted = await ingestBatch(c.req.valid('json'));
    c.header('Cache-Control', 'no-store');
    return c.json(accepted, 202);
  }
);
