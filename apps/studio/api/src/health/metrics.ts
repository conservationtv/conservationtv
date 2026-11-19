import type { MetricDefinition, MetricDimensions, MetricSummary } from '@conservationtv/reports';
import { and, eq, gt, lte, sql } from 'drizzle-orm';
import pLimit from 'p-limit';
import { metricPoints, metricSeries } from '../db/schema.ts';
import { useDB } from '../db/transaction.ts';
import type { Consulted } from './health.ts';

// The metrics an evaluator may read (src/health/evaluator.ts): one reporter's series about one subject, as of the
// evaluation's time and no later, so judging the same reports twice gives the same opinion, and a late batch is judged
// as of its own time. An evaluator asks for what its opinion rests on, as it goes: nothing is read that it does not
// ask for, the same question is read once per evaluation, and every read is recorded, so the opinion says what it was
// formed from. Evaluators may ask several questions at once, but a transaction is one connection, so the reads take
// turns.

/** The furthest back an evaluation may read. */
export const MAX_LOOKBACK_SECONDS = 60 * 60;

/** One series of a metric, as read: a summary of its points, and when the newest was observed. */
export interface Reading {
  seriesId: string;
  dimensions: MetricDimensions;
  summary: MetricSummary;
  observedAt: Date;
}

/** Whose series an evaluation reads, and as of when. */
export interface MetricScope {
  organisationId: string;
  subjectId: string;
  reporterId: string;
  at: Date;
}

/** One reporter's metrics about one subject, as of the evaluation's time. Each read returns every matching series. */
export interface SubjectMetrics {
  /**
   * Each series' points over the last `seconds`, summarised as one: the least and greatest values, the mean weighted
   * by samples, the last value and how many samples. A series with no points then is absent.
   */
  over(metric: MetricDefinition, seconds: number, dimensions?: MetricDimensions): Promise<Reading[]>;
}

/** A `SubjectMetrics` over the database, in the trusted transaction the caller is in, and what it was asked. */
export function subjectMetrics(scope: MetricScope) {
  const asked = new Map<string, Promise<Reading[]>>();
  const consulted: Consulted[] = [];
  /** One read at a time: a transaction is one connection. A failed read fails only the question it answers. */
  const inTurn = pLimit(1);

  /** Read once per evaluation, and record what was read. */
  const remember = (
    metric: MetricDefinition,
    read: Consulted['read'],
    dimensions: MetricDimensions,
    load: () => Promise<Reading[]>
  ) => {
    const key = JSON.stringify([metric.name, metric.unit, read, dimensions]);
    const known = asked.get(key);
    if (known !== undefined) return known;
    const readings = inTurn(load).then(rows => {
      consulted.push({ metric: metric.name, read, seriesIds: rows.map(({ seriesId }) => seriesId) });
      return rows;
    });
    asked.set(key, readings);
    return readings;
  };

  const metrics: SubjectMetrics = {
    over: (metric, seconds, dimensions = {}) => {
      if (seconds <= 0 || seconds > MAX_LOOKBACK_SECONDS)
        throw new Error(`An evaluation reads at most ${MAX_LOOKBACK_SECONDS} seconds back, not ${seconds}`);
      return remember(metric, seconds, dimensions, () => summarisedPoints(scope, metric, seconds, dimensions));
    }
  };
  return { metrics, consulted };
}

/** The series of `metric` in scope with all of `dimensions`, whose points were observed after `from`. */
function pointsOf(scope: MetricScope, metric: MetricDefinition, dimensions: MetricDimensions, from: Date) {
  return and(
    eq(metricSeries.organisationId, scope.organisationId),
    eq(metricSeries.subjectId, scope.subjectId),
    eq(metricSeries.reporterId, scope.reporterId),
    eq(metricSeries.name, metric.name),
    eq(metricSeries.unit, metric.unit),
    sql`${metricSeries.dimensions} @> ${JSON.stringify(dimensions)}::jsonb`,
    eq(metricPoints.organisationId, scope.organisationId),
    gt(metricPoints.observedAt, from),
    lte(metricPoints.observedAt, scope.at)
  );
}

function secondsBefore(at: Date, seconds: number) {
  const time = at.getTime();
  return new Date(time - seconds * 1000);
}

async function summarisedPoints(
  scope: MetricScope,
  metric: MetricDefinition,
  seconds: number,
  dimensions: MetricDimensions
) {
  const db = useDB({ trusted: true });
  const from = secondsBefore(scope.at, seconds);
  const rows = await db
    .select({
      seriesId: metricPoints.seriesId,
      dimensions: metricSeries.dimensions,
      observedAt: sql`max(${metricPoints.observedAt})`.mapWith(metricPoints.observedAt),
      min: sql<number>`min(${metricPoints.min})`,
      max: sql<number>`max(${metricPoints.max})`,
      avg: sql<number>`sum(${metricPoints.avg} * ${metricPoints.count}) / sum(${metricPoints.count})`,
      last: sql<number>`last(${metricPoints.last}, ${metricPoints.observedAt})`,
      count: sql<number>`sum(${metricPoints.count})::integer`
    })
    .from(metricPoints)
    .innerJoin(metricSeries, eq(metricSeries.id, metricPoints.seriesId))
    .where(pointsOf(scope, metric, dimensions, from))
    .groupBy(metricPoints.seriesId, metricSeries.dimensions)
    .orderBy(metricPoints.seriesId);
  return rows.map(readingOf);
}

interface PointRow extends MetricSummary {
  seriesId: string;
  dimensions: MetricDimensions;
  observedAt: Date;
}

function readingOf({ seriesId, dimensions, observedAt, min, max, avg, last, count }: PointRow): Reading {
  return { seriesId, dimensions, observedAt, summary: { min, max, avg, last, count } };
}
