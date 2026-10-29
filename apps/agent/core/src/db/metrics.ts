import type { MetricDimensions } from '@conservationtv/reports';
import { and, asc, eq, gte, lt, max, min, sql } from 'drizzle-orm';
import type { SeriesQuery } from '../routes/metrics.ts';
import type { Metric } from '../runtimes/reports.ts';
import { type AgentDatabase, useDatabase } from './database.ts';
import { metricPoints, metricSeries } from './schema.ts';

// Every sample the agent's runtimes take, kept on its disk: each a point in a series, made the first time a runtime
// records it. The studio API gets each interval's summary (runtimes/reports.ts); this keeps what it was made from.

/** Each database's series ids by key, so a sample costs one insert once its series is known. */
const seriesIds = new WeakMap<AgentDatabase, Map<string, number>>();

/** A series' identity, with its dimensions' keys in order so the same dimensions always make the same key. */
function keyOf(subjectId: string | null, name: string, unit: string, dimensions: MetricDimensions): string {
  const entries = Object.entries(dimensions).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([subjectId, name, unit, Object.fromEntries(entries)]);
}

/** The series' id, made if it is new. */
function seriesIdOf(db: AgentDatabase, subjectId: string | null, metric: Metric): number {
  const ids = seriesIds.get(db) ?? new Map<string, number>();
  seriesIds.set(db, ids);
  const unit = metric.unit ?? '';
  const dimensions = metric.dimensions ?? {};
  const key = keyOf(subjectId, metric.name, unit, dimensions);
  const known = ids.get(key);
  if (known !== undefined) return known;
  const now = new Date();
  db.insert(metricSeries)
    .values({ key, subjectId, name: metric.name, unit, dimensions, createdAt: now })
    .onConflictDoNothing()
    .run();
  const row = db.select({ id: metricSeries.id }).from(metricSeries).where(eq(metricSeries.key, key)).get();
  if (row === undefined) throw new Error(`The series ${key} was neither made nor found`);
  ids.set(key, row.id);
  return row.id;
}

/**
 * Record `metrics`, all sampled at once and about `subjectId`, or the device without one. Only samples are kept: a
 * summary is what the studio API gets, made from them.
 */
export function recordMetrics(observedAt: Date, metrics: Metric[], subjectId?: string): void {
  const db = useDatabase();
  const points = metrics.flatMap(metric =>
    'value' in metric ? [{ seriesId: seriesIdOf(db, subjectId ?? null, metric), observedAt, value: metric.value }] : []
  );
  if (points.length === 0) return;
  db.insert(metricPoints).values(points).onConflictDoNothing().run();
}

/** Every series, by name, with the range of its points; optionally of one metric. */
export function listMetricSeries(filter: SeriesQuery) {
  const db = useDatabase();
  return db
    .select({
      id: metricSeries.id,
      subjectId: metricSeries.subjectId,
      name: metricSeries.name,
      unit: metricSeries.unit,
      dimensions: metricSeries.dimensions,
      firstObservedAt: min(metricPoints.observedAt),
      lastObservedAt: max(metricPoints.observedAt)
    })
    .from(metricSeries)
    .leftJoin(metricPoints, eq(metricPoints.seriesId, metricSeries.id))
    .where(filter.name === undefined ? undefined : eq(metricSeries.name, filter.name))
    .groupBy(metricSeries.id)
    .orderBy(asc(metricSeries.name), asc(metricSeries.id))
    .all();
}

export function getMetricSeries(seriesId: number) {
  const db = useDatabase();
  return db
    .select({
      id: metricSeries.id,
      subjectId: metricSeries.subjectId,
      name: metricSeries.name,
      unit: metricSeries.unit,
      dimensions: metricSeries.dimensions
    })
    .from(metricSeries)
    .where(eq(metricSeries.id, seriesId))
    .get();
}

/** A range of time, in buckets of `step` seconds. */
export interface BucketRange {
  from: Date;
  to: Date;
  step: number;
}

/**
 * The series' points in the range, oldest first, in buckets of `step` seconds: each bucket's least and greatest
 * samples, their mean, the last and how many there were, as the studio API summarises its points. A bucket with no
 * points is absent.
 */
export function listMetricPoints(seriesId: number, range: BucketRange) {
  const db = useDatabase();
  // `step` is an integer, written into the query so the bucket is the same expression wherever it appears.
  const stepMs = sql.raw(String(Math.trunc(range.step) * 1000));
  const bucket = sql<number>`(${metricPoints.observedAt} / ${stepMs}) * ${stepMs}`;
  const ranked = db
    .select({
      at: bucket.as('at'),
      value: metricPoints.value,
      // 1 for each bucket's last point.
      recency: sql<number>`row_number() over (partition by ${bucket} order by ${metricPoints.observedAt} desc)`.as(
        'recency'
      )
    })
    .from(metricPoints)
    .where(
      and(
        eq(metricPoints.seriesId, seriesId),
        gte(metricPoints.observedAt, range.from),
        lt(metricPoints.observedAt, range.to)
      )
    )
    .as('ranked');
  return db
    .select({
      at: sql`${ranked.at}`.mapWith(metricPoints.observedAt),
      min: sql<number>`min(${ranked.value})`,
      max: sql<number>`max(${ranked.value})`,
      avg: sql<number>`avg(${ranked.value})`,
      last: sql<number>`max(case when ${ranked.recency} = 1 then ${ranked.value} end)`,
      count: sql<number>`count(*)`
    })
    .from(ranked)
    .groupBy(ranked.at)
    .orderBy(ranked.at)
    .all();
}
