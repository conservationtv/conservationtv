import { z } from 'zod';
import { logRecords, metricSamples, observations } from '../db/schema.ts';
import { ApiFailure } from '../errors.ts';
import { trusted } from '../organisations/membership.ts';
import type { AuthenticatedDevice } from '../middleware/device.ts';
import { useServices } from '../services.ts';
import { MetricDimensionsSchema, SettingsSchema } from '../topology/settings.ts';
import { deviceSubject, SubjectIdSchema } from './subjects.ts';

// Report ingestion: trusted code on the owning connection, because the device's signature, not a session,
// authenticates the reporter (src/middleware/device.ts). Any device reports, in batches, about whichever subjects it
// names (src/reports/subjects.ts): which subjects a device may report about is not restricted yet.
//
// A batch is accepted or refused whole, and only for trust or shape: an unsigned, tampered or replayed request, a
// malformed report or one observed in the future. Everything else is stored as given. Reports are cheap operational
// signals, so nothing deduplicates them beyond the signature's single-use nonce: a device that retries a batch signs it
// again, and it may be stored twice. Ordering, late reports and their effect on state are the state consumer's
// concern.

/** How far ahead of the control plane's clock a report's observation time may be. */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** The most reports one batch may carry. */
export const MAX_BATCH_REPORTS = 1000;

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

/** The signed batch: one device's reports, of any kinds and subjects. */
export const BatchSchema = z.strictObject({
  reports: z
    .array(z.discriminatedUnion('kind', [EventReportSchema, MetricReportSchema, LogReportSchema]))
    .min(1)
    .max(MAX_BATCH_REPORTS)
});
export type Batch = z.output<typeof BatchSchema>;

/** Store every report in the batch, as the device that signed it. */
export function ingestBatch(device: AuthenticatedDevice, batch: Batch) {
  return trusted(async tx => {
    // Refuse the whole batch if any report is from the future, then store each kind with one insert.
    const services = useServices();
    const now = services.clock();
    if (batch.reports.some(report => Date.parse(report.observedAt) > now + MAX_CLOCK_SKEW_MS))
      throw new ApiFailure('invalid_report');

    const reported = (report: EventReport | MetricReport | LogReport) => ({
      organisationId: device.organisationId,
      reporterId: deviceSubject(device.id),
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
