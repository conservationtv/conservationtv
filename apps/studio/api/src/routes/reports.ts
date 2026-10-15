import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { ingestEvent, ingestLog, ingestMetric, SubmissionSchema } from '../reports/ingest.ts';
import {
  invalidRequest,
  invalidSignature,
  metricSeriesConflict,
  operationVersion,
  unavailable,
  validator,
  versionMismatch
} from './openapi.ts';

const signing =
  'The `report` is JSON text signed, byte for byte, by one of the reporting agent’s registered Ed25519 keys; `reporterId` must be that agent. Submitting the same report ID again stores nothing and reports `duplicate: true`.';

// The three ingestion endpoints, one per signal type. Agents call them with no session: each submission is
// authenticated by its signature (src/reports/ingest.ts).
export default new Hono()
  .post(
    '/events',
    describeRoute({
      operationId: 'reports.events.submit',
      ...operationVersion(1),
      summary: 'Submit an event report',
      description: `An observation about a subject, such as a heartbeat or whether video is being received, added to the event stream from which subject state is derived. ${signing}`,
      responses: {
        202: { description: 'Accepted' },
        400: invalidRequest,
        401: invalidSignature,
        412: versionMismatch,
        503: unavailable
      }
    }),
    validator('json', SubmissionSchema),
    async c => {
      const accepted = await ingestEvent(c.req.valid('json'));
      c.header('Cache-Control', 'no-store');
      return c.json({ id: accepted.id, duplicate: accepted.duplicate }, 202);
    }
  )
  .post(
    '/metrics',
    describeRoute({
      operationId: 'reports.metrics.submit',
      ...operationVersion(1),
      summary: 'Submit a metric report',
      description: `A measurement of a gauge or counter about a subject, stored as a sample in the reporter's own series for that metric and its dimensions. ${signing}`,
      responses: {
        202: { description: 'Accepted' },
        400: invalidRequest,
        401: invalidSignature,
        409: metricSeriesConflict,
        412: versionMismatch,
        503: unavailable
      }
    }),
    validator('json', SubmissionSchema),
    async c => {
      const accepted = await ingestMetric(c.req.valid('json'));
      c.header('Cache-Control', 'no-store');
      return c.json({ id: accepted.id, duplicate: accepted.duplicate }, 202);
    }
  )
  .post(
    '/logs',
    describeRoute({
      operationId: 'reports.logs.submit',
      ...operationVersion(1),
      summary: 'Submit a log report',
      description: `A log message about a subject, with its level and structured context. ${signing}`,
      responses: {
        202: { description: 'Accepted' },
        400: invalidRequest,
        401: invalidSignature,
        412: versionMismatch,
        503: unavailable
      }
    }),
    validator('json', SubmissionSchema),
    async c => {
      const accepted = await ingestLog(c.req.valid('json'));
      c.header('Cache-Control', 'no-store');
      return c.json({ id: accepted.id, duplicate: accepted.duplicate }, 202);
    }
  );
