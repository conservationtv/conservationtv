import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { logRecords, metricPoints, metricSeries, observations } from '../db/schema.ts';
import { ApiFailure } from '../errors.ts';
import { trusted } from '../organisations/membership.ts';
import type { AuthenticatedDevice } from '../middleware/device.ts';
import { useEnvironment } from '../env/env.ts';
import { MetricDimensionsSchema, SettingsSchema } from '../topology/settings.ts';
import { deviceSubject, SubjectIdSchema } from './subjects.ts';

// Report ingestion: trusted code on the owning connection, because the device's signature, not a session,
// authenticates the reporter (src/middleware/device.ts). Any device reports, in batches, about whichever subjects it
// names (src/reports/subjects.ts): which subjects a device may report about is not restricted yet.
//
// A batch is accepted or refused whole, and only for trust or shape: an unsigned, tampered or replayed request, a
// malformed report or one observed in the future. Everything else is stored as given. Events and logs are cheap
// operational signals, so nothing deduplicates them beyond the signature's single-use nonce: a device that retries a
// batch signs it again, and they may be stored twice. A metric point is keyed by its series and time, so a retried one
// is skipped. Ordering, late reports and their effect on state are the state consumer's concern.

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

/** What a reporter saw of a metric over an interval: `count` samples, their least, greatest, mean and last values. */
export const MetricSummarySchema = z
  .strictObject({
    min: z.number(),
    max: z.number(),
    avg: z.number(),
    last: z.number(),
    count: z.number().int().min(1)
  })
  .refine(
    ({ min, max, avg, last }) => min <= avg && avg <= max && min <= last && last <= max,
    'A summary’s mean and last value are between its least and greatest.'
  );
export type MetricSummary = z.output<typeof MetricSummarySchema>;

/** What names a metric's series about the subject, from the reporting device. */
const MetricSeriesSchema = z.strictObject({
  name: z.string().min(1).max(200),
  unit: z.string().min(1).max(60).nullable().default(null),
  dimensions: MetricDimensionsSchema.default({})
});
type MetricSeries = z.output<typeof MetricSeriesSchema>;

/**
 * A point in a metric's series: one sample's `value`, or a `summary` of the interval that ends at the report's
 * `observedAt`. The series is the metric's name, unit and dimensions about the subject, from the reporting device.
 */
export const MetricReportSchema = reportOf(
  'metric',
  z.union([
    MetricSeriesSchema.extend({ value: z.number() }),
    MetricSeriesSchema.extend({ summary: MetricSummarySchema })
  ])
);
export type MetricReport = z.output<typeof MetricReportSchema>;

/** A series' identity within one organisation and reporter, as a lookup key. jsonb keeps keys in its own order. */
function seriesKey(subjectId: string, { name, unit, dimensions }: MetricSeries) {
  const entries = Object.entries(dimensions).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([subjectId, name, unit, entries]);
}

function summaryOf(payload: MetricReport['payload']): MetricSummary {
  if ('summary' in payload) return payload.summary;
  const { value } = payload;
  return { min: value, max: value, avg: value, last: value, count: 1 };
}

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
    const environment = useEnvironment();
    const now = environment.clock();
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
    if (metrics.length > 0) {
      // Make the series the batch names that do not exist yet, then look every one of them up: a series another
      // batch made meanwhile is skipped by the first statement, and seen by the second.
      const organisationId = device.organisationId;
      const reporterId = deviceSubject(device.id);
      const series = metrics.map(({ subjectId, payload: { name, unit, dimensions } }) => ({
        organisationId,
        reporterId,
        subjectId,
        name,
        unit,
        dimensions
      }));
      await tx.insert(metricSeries).values(series).onConflictDoNothing();
      const subjectIds = [...new Set(series.map(({ subjectId }) => subjectId))];
      const names = [...new Set(series.map(({ name }) => name))];
      const known = await tx
        .select({
          id: metricSeries.id,
          subjectId: metricSeries.subjectId,
          name: metricSeries.name,
          unit: metricSeries.unit,
          dimensions: metricSeries.dimensions
        })
        .from(metricSeries)
        .where(
          and(
            eq(metricSeries.organisationId, organisationId),
            eq(metricSeries.reporterId, reporterId),
            inArray(metricSeries.subjectId, subjectIds),
            inArray(metricSeries.name, names)
          )
        );
      const ids = new Map(known.map(row => [seriesKey(row.subjectId, row), row.id]));
      const points = metrics.map(({ subjectId, observedAt, payload }) => {
        const seriesId = ids.get(seriesKey(subjectId, payload));
        if (seriesId === undefined) throw new Error(`No series for ${payload.name} about ${subjectId}`);
        return { seriesId, organisationId, observedAt: new Date(observedAt), ...summaryOf(payload) };
      });
      await tx.insert(metricPoints).values(points).onConflictDoNothing();
    }
    if (logs.length > 0)
      await tx.insert(logRecords).values(logs.map(report => ({ ...reported(report), ...report.payload })));
    return { accepted: batch.reports.length };
  });
}
