import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { useCache } from '../cache/cache.ts';
import { agents, logRecords, metricSamples, observations } from '../db/schema.ts';
import { ApiFailure } from '../errors.ts';
import { trusted, type Transaction } from '../organisations/membership.ts';
import type { AuthenticatedDevice } from '../middleware/device.ts';
import { useServices } from '../services.ts';
import { MetricDimensionsSchema, SettingsSchema } from '../topology/settings.ts';
import { SubjectIdSchema } from './subjects.ts';

// Report ingestion: trusted code on the owning connection, because the device's signature, not a session,
// authenticates the reporter (src/middleware/device.ts). Only an agent reports, in batches, about whichever subjects it
// names (src/reports/subjects.ts): which subjects an agent may report about is not restricted yet.
//
// A batch is accepted or refused whole, and only for trust or shape: an unsigned or tampered request, a device that is
// not an agent, a malformed report or one observed in the future. Everything else is stored as given. Each batch
// carries an idempotency key, and a retry with the same key and body returns the first result without storing the
// batch again; the result is kept in the cache (src/cache/cache.ts) for a day, so with Workers KV, two concurrent or
// near-simultaneous retries can still both be stored. Ordering, late reports and their effect on state are the state
// consumer's concern.

/** How far ahead of the control plane's clock a report's observation time may be. */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** The most reports one batch may carry. */
export const MAX_BATCH_REPORTS = 1000;

/** How long a batch's result is kept for retries with its idempotency key. */
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

export const IdempotencyKeySchema = z
  .string()
  .regex(/^[\x21-\x7e]{1,255}$/)
  .describe('Unique to the batch: a retry with the same key and body returns the first result.');
export type IdempotencyKey = z.output<typeof IdempotencyKeySchema>;

/** What a stored batch returns, and what a retry with its key returns again. */
const AcceptedSchema = z.object({ accepted: z.int() });
export type Accepted = z.output<typeof AcceptedSchema>;

/** A batch's stored result, with the SHA-256 of the body it was stored from. */
const IdempotentResultSchema = z.object({ bodyHash: z.string(), result: AcceptedSchema });
export type IdempotentResult = z.output<typeof IdempotentResultSchema>;

const reportOf = <Kind extends string, Payload extends z.ZodType>(kind: Kind, payload: Payload) =>
  z.strictObject({
    kind: z.literal(kind),
    subjectId: SubjectIdSchema,
    observedAt: z.iso.datetime({ offset: true }),
    payload
  });

export const EventReportSchema = reportOf(
  'event',
  z.strictObject({ type: z.string().min(1).max(120), data: SettingsSchema.default({}) })
);
export type EventReport = z.output<typeof EventReportSchema>;

export const MetricReportSchema = reportOf(
  'metric',
  z.strictObject({
    name: z.string().min(1).max(200),
    type: z.enum(['gauge', 'counter']),
    value: z.number(),
    unit: z.string().min(1).max(60).nullable().default(null),
    dimensions: MetricDimensionsSchema.default({})
  })
);
export type MetricReport = z.output<typeof MetricReportSchema>;

export const LogReportSchema = reportOf(
  'log',
  z.strictObject({
    level: z.string().min(1).max(20),
    message: z.string().max(16_384),
    context: SettingsSchema.default({})
  })
);
export type LogReport = z.output<typeof LogReportSchema>;

/** The signed batch: one agent's reports, of any kinds and subjects. */
export const BatchSchema = z.strictObject({
  reports: z
    .array(z.discriminatedUnion('kind', [EventReportSchema, MetricReportSchema, LogReportSchema]))
    .min(1)
    .max(MAX_BATCH_REPORTS)
});
export type Batch = z.output<typeof BatchSchema>;

/** The signing device's agent, which must exist: only agents report. */
async function reportingAgent(tx: Transaction, device: AuthenticatedDevice) {
  const [agent] = await tx
    .select({ id: agents.id, organisationId: agents.organisationId })
    .from(agents)
    .where(eq(agents.id, device.id));
  if (!agent) throw new ApiFailure('not_an_agent');
  return agent;
}

/** Store every report in the batch, as the device's agent. */
function storeBatch(device: AuthenticatedDevice, batch: Batch) {
  return trusted(async tx => {
    // Refuse the whole batch if any report is from the future, then store each kind with one insert.
    const agent = await reportingAgent(tx, device);
    const services = useServices();
    const now = services.clock();
    if (batch.reports.some(report => Date.parse(report.observedAt) > now + MAX_CLOCK_SKEW_MS))
      throw new ApiFailure('invalid_report');

    const reported = (report: EventReport | MetricReport | LogReport) => ({
      organisationId: agent.organisationId,
      reporterId: agent.id,
      subjectId: report.subjectId,
      observedAt: new Date(report.observedAt)
    });
    const events = batch.reports.filter(report => report.kind === 'event');
    const metrics = batch.reports.filter(report => report.kind === 'metric');
    const logs = batch.reports.filter(report => report.kind === 'log');
    if (events.length > 0)
      await tx
        .insert(observations)
        .values(events.map(report => ({ ...reported(report), type: report.payload.type, data: report.payload.data })));
    if (metrics.length > 0)
      await tx.insert(metricSamples).values(metrics.map(report => ({ ...reported(report), ...report.payload })));
    if (logs.length > 0)
      await tx.insert(logRecords).values(logs.map(report => ({ ...reported(report), ...report.payload })));
    return { accepted: batch.reports.length };
  });
}

/** The result stored under the key, if any; `idempotency_key_reused` if it was for a different body. */
async function previousResult(key: string, bodyHash: string) {
  const cache = useCache();
  const stored = await cache.get(key);
  if (stored === null) return undefined;
  const previous = IdempotentResultSchema.parse(JSON.parse(stored));
  if (previous.bodyHash !== bodyHash) throw new ApiFailure('idempotency_key_reused');
  return previous.result;
}

/**
 * Store a signed batch once per idempotency key: a retry with the same key and body returns the first result. `body`
 * is the request body the batch was parsed from.
 */
export async function ingestBatch(
  device: AuthenticatedDevice,
  idempotencyKey: string,
  body: ArrayBuffer,
  batch: Batch
) {
  const key = `report-batch:${device.id}:${idempotencyKey}`;
  const bodyHash = createHash('sha256').update(Buffer.from(body)).digest('base64');
  const previous = await previousResult(key, bodyHash);
  if (previous) return previous;
  const result = await storeBatch(device, batch);
  const cache = useCache();
  const stored: IdempotentResult = { bodyHash, result };
  await cache.put(key, JSON.stringify(stored), IDEMPOTENCY_TTL_SECONDS);
  return result;
}
