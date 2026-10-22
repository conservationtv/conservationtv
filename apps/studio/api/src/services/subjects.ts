import { and, asc, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { logRecords, metricPoints, metricSeries, observations, reporterOpinions, subjectStates } from '../db/schema.ts';
import { useDB } from '../db/transaction.ts';

// What devices report about a subject, and what the state consumer derives from it. A subject is a string
// (`@conservationtv/reports`), so one nothing was reported about reads as empty. Freshness is evaluated by Postgres
// against each expiry when read, so state goes stale without a new report.

export interface HistoryPage {
  /** At most this many, newest first. */
  limit: number;
  /** Only those observed before this time, to page back. */
  before?: string;
}

export interface MetricSeriesFilter {
  /** Only series of this metric. */
  name?: string;
}

/** A time range, read in buckets of `step` seconds. */
export interface BucketRange {
  from: Date;
  to: Date;
  step: number;
}

/** The subject's combined state, as the state consumer last derived it, if it has. */
export async function getSubjectState(organisationId: string, subjectId: string) {
  const db = useDB();
  const [row] = await db
    .select({
      health: subjectStates.health,
      state: subjectStates.state,
      freshness: sql<'fresh' | 'stale'>`case when ${subjectStates.expiresAt} > now() then 'fresh' else 'stale' end`,
      observedAt: subjectStates.observedAt,
      expiresAt: subjectStates.expiresAt,
      computedAt: subjectStates.computedAt,
      contributingReporterIds: subjectStates.contributingReporterIds,
      evidenceReportIds: subjectStates.evidenceReportIds
    })
    .from(subjectStates)
    .where(and(eq(subjectStates.organisationId, organisationId), eq(subjectStates.subjectId, subjectId)));
  return row;
}

/** Each reporter's opinion of the subject, oldest reporter first. */
export function listReporterOpinions(organisationId: string, subjectId: string) {
  const db = useDB();
  return db
    .select({
      reporterId: reporterOpinions.reporterId,
      health: reporterOpinions.health,
      state: reporterOpinions.state,
      freshness: sql<'fresh' | 'stale'>`case when ${reporterOpinions.expiresAt} > now() then 'fresh' else 'stale' end`,
      observedAt: reporterOpinions.observedAt,
      expiresAt: reporterOpinions.expiresAt,
      evidenceReportIds: reporterOpinions.evidenceReportIds
    })
    .from(reporterOpinions)
    .where(and(eq(reporterOpinions.organisationId, organisationId), eq(reporterOpinions.subjectId, subjectId)))
    .orderBy(reporterOpinions.reporterId);
}

/** The events reported about the subject, newest observation first. */
export function listObservations(organisationId: string, subjectId: string, page: HistoryPage) {
  const db = useDB();
  return db
    .select({
      id: observations.id,
      reporterId: observations.reporterId,
      observedAt: observations.observedAt,
      receivedAt: observations.receivedAt,
      type: observations.type,
      data: observations.data
    })
    .from(observations)
    .where(
      and(
        eq(observations.organisationId, organisationId),
        eq(observations.subjectId, subjectId),
        page.before === undefined ? undefined : lt(observations.observedAt, new Date(page.before))
      )
    )
    .orderBy(desc(observations.observedAt))
    .limit(page.limit);
}

/** The logs reported about the subject, newest observation first. */
export function listLogs(organisationId: string, subjectId: string, page: HistoryPage) {
  const db = useDB();
  return db
    .select({
      id: logRecords.id,
      reporterId: logRecords.reporterId,
      observedAt: logRecords.observedAt,
      receivedAt: logRecords.receivedAt,
      level: logRecords.level,
      message: logRecords.message,
      context: logRecords.context
    })
    .from(logRecords)
    .where(
      and(
        eq(logRecords.organisationId, organisationId),
        eq(logRecords.subjectId, subjectId),
        page.before === undefined ? undefined : lt(logRecords.observedAt, new Date(page.before))
      )
    )
    .orderBy(desc(logRecords.observedAt))
    .limit(page.limit);
}

/** The metric series reported about the subject, by name, then oldest first. */
export function listMetricSeries(organisationId: string, subjectId: string, filter: MetricSeriesFilter) {
  const db = useDB();
  return db
    .select({
      id: metricSeries.id,
      name: metricSeries.name,
      reporterId: metricSeries.reporterId,
      unit: metricSeries.unit,
      dimensions: metricSeries.dimensions,
      createdAt: metricSeries.createdAt
    })
    .from(metricSeries)
    .where(
      and(
        eq(metricSeries.organisationId, organisationId),
        eq(metricSeries.subjectId, subjectId),
        filter.name === undefined ? undefined : eq(metricSeries.name, filter.name)
      )
    )
    .orderBy(asc(metricSeries.name), asc(metricSeries.createdAt));
}

/** One of the subject's metric series, if it is visible. */
export async function getMetricSeries(organisationId: string, subjectId: string, seriesId: string) {
  const db = useDB();
  const [row] = await db
    .select({
      id: metricSeries.id,
      name: metricSeries.name,
      reporterId: metricSeries.reporterId,
      unit: metricSeries.unit,
      dimensions: metricSeries.dimensions,
      createdAt: metricSeries.createdAt
    })
    .from(metricSeries)
    .where(
      and(
        eq(metricSeries.organisationId, organisationId),
        eq(metricSeries.subjectId, subjectId),
        eq(metricSeries.id, seriesId)
      )
    );
  return row;
}

/**
 * The series' points in the range, oldest first, in buckets of `step` seconds: each bucket's least and greatest
 * values, the mean weighted by samples, the last value and how many samples it summarises. A bucket with no points is
 * absent.
 */
export function listMetricPoints(organisationId: string, seriesId: string, range: BucketRange) {
  const db = useDB();
  // `step` is an integer, written into the query so GROUP BY can match the bucket expression.
  const step = sql.raw(String(Math.trunc(range.step)));
  const bucket = sql`time_bucket(make_interval(secs => ${step}), ${metricPoints.observedAt})`;
  return db
    .select({
      at: bucket.mapWith(metricPoints.observedAt),
      min: sql<number>`min(${metricPoints.min})`,
      max: sql<number>`max(${metricPoints.max})`,
      avg: sql<number>`sum(${metricPoints.avg} * ${metricPoints.count}) / sum(${metricPoints.count})`,
      last: sql<number>`last(${metricPoints.last}, ${metricPoints.observedAt})`,
      count: sql<number>`sum(${metricPoints.count})::integer`
    })
    .from(metricPoints)
    .where(
      and(
        eq(metricPoints.organisationId, organisationId),
        eq(metricPoints.seriesId, seriesId),
        gte(metricPoints.observedAt, range.from),
        lt(metricPoints.observedAt, range.to)
      )
    )
    .groupBy(bucket)
    .orderBy(bucket);
}
