import {
  deviceSubject,
  MetricDimensionsSchema,
  MetricSummarySchema,
  SubjectIdSchema,
  type MetricSummary
} from '@conservationtv/reports';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { logRecords, metricPoints, metricSeries, observations } from '../db/schema.ts';
import { ApiFailure } from '../errors.ts';
import { trustedTransaction, useDB } from '../db/transaction.ts';
import type { AuthenticatedDevice } from '../middleware/device.ts';
import { useEnvironment } from '../env/env.ts';
import { evaluateReported, type Reported } from '../health/consumer.ts';
import { SettingsSchema } from '../topology/settings.ts';

// Report ingestion: trusted code on the owning connection, because the device's signature, not a session,
// authenticates the reporter (src/middleware/device.ts). Any device reports, in batches, about whichever subjects it
// names (`@conservationtv/reports`): which subjects a device may report about is not restricted yet.
//
// A batch is accepted or refused whole, and only for trust or shape: an unsigned, tampered or expired request, a
// malformed report or one observed in the future. Everything else is stored as given. Events and logs are cheap
// operational signals, so nothing deduplicates them: a retried or replayed batch may be stored twice. A metric point is
// keyed by its series and time, so a retried one is skipped. Ordering, late reports and their effect on state are the
// state consumer's concern (src/health/consumer.ts), which judges the subjects a batch's metrics are about once the
// batch is stored. It runs before the response rather than in the background, since the request's connections close
// once the response is sent; a subject it fails to judge is logged, never refusing the stored batch.

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

/** Store every report in the batch, as the device that signed it, then judge the subjects its metrics are about. */
export async function ingestBatch(device: AuthenticatedDevice, batch: Batch) {
  const accepted = await storeBatch(device, batch);
  const reported = reportedOf(device, batch);
  await evaluateReported(reported);
  return accepted;
}

/** The subjects the batch reports metrics about, each as of its newest metric. */
function reportedOf(device: AuthenticatedDevice, batch: Batch): Reported {
  const subjects = new Map<string, Date>();
  for (const report of batch.reports) {
    if (report.kind !== 'metric') continue;
    const observedAt = new Date(report.observedAt);
    const newest = subjects.get(report.subjectId);
    if (newest === undefined || observedAt > newest) subjects.set(report.subjectId, observedAt);
  }
  return { organisationId: device.organisationId, reporterId: deviceSubject(device.id), subjects };
}

/** The series a batch's metrics belong to, as it names them: one per metric, repeats and all. */
function seriesOf(device: AuthenticatedDevice, batch: Batch) {
  const organisationId = device.organisationId;
  const reporterId = deviceSubject(device.id);
  const metrics = batch.reports.filter(report => report.kind === 'metric');
  return metrics.map(({ subjectId, payload: { name, unit, dimensions } }) => ({
    organisationId,
    reporterId,
    subjectId,
    name,
    unit,
    dimensions
  }));
}

/**
 * Make the series the batch names that do not exist yet, in a transaction of their own, committed before any point is
 * stored. `metric_point` is a hypertable with a foreign key to `metric_series`: the first point of a day makes the
 * day's chunk, which locks `metric_point` and then `metric_series` more strongly than an insert into it does. Two
 * batches that each held their own series insert while making that chunk waited on each other, and one was killed
 * (deadlock, 40P01). With the series committed first, neither holds anything on `metric_series` by then. A series left
 * behind by a batch whose points then fail is harmless: the next batch finds it.
 */
async function storeSeries(device: AuthenticatedDevice, batch: Batch) {
  const series = seriesOf(device, batch);
  if (series.length === 0) return;
  await trustedTransaction(
    async () => {
      const db = useDB({ trusted: true });
      await db.insert(metricSeries).values(series).onConflictDoNothing();
    },
    { name: 'reports.series' }
  );
}

async function storeBatch(device: AuthenticatedDevice, batch: Batch) {
  // Refuse the whole batch if any report is from the future, before anything of it is stored.
  const environment = useEnvironment();
  const now = environment.clock();
  if (batch.reports.some(report => Date.parse(report.observedAt) > now + MAX_CLOCK_SKEW_MS))
    throw new ApiFailure('invalid_report');
  await storeSeries(device, batch);
  return trustedTransaction(
    async () => {
      const db = useDB({ trusted: true });
      // Each kind with one insert.

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
        await db
          .insert(observations)
          .values(
            events.map(report => ({ ...reported(report), type: report.payload.type, data: report.payload.data }))
          );
      if (metrics.length > 0) {
        // Look up every series the batch names: each exists by now (`storeSeries`), made by this batch or another.
        const organisationId = device.organisationId;
        const reporterId = deviceSubject(device.id);
        const series = seriesOf(device, batch);
        const subjectIds = [...new Set(series.map(({ subjectId }) => subjectId))];
        const names = [...new Set(series.map(({ name }) => name))];
        const known = await db
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
        await db.insert(metricPoints).values(points).onConflictDoNothing();
      }
      if (logs.length > 0)
        await db.insert(logRecords).values(logs.map(report => ({ ...reported(report), ...report.payload })));
      return { accepted: batch.reports.length };
    },
    { name: 'reports.store' }
  );
}
