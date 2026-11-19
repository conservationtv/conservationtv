import type { MetricDefinition, MetricDimensions, MetricSummary } from '@conservationtv/reports';
import { type Evaluator, formOpinion, type Opinion, type Subject } from '../../src/health/evaluator.ts';
import type { Consulted, Finding } from '../../src/health/health.ts';
import type { Reading, SubjectMetrics } from '../../src/health/metrics.ts';

// A harness for judging an evaluator on its own, as the state consumer would, without a database or the topology:
// a reporter that reports about one subject minute by minute, as agents submit summaries, and after each minute's
// batch is judged by the evaluator, as of that minute, from everything it has reported so far and the opinion it
// formed last. Each opinion is formed by the consumer's own `formOpinion`, so settling (hysteresis) and expiry are
// exercised too. The context is whatever the test says the topology holds.
//
//   const output = reporter(evaluators.forward, { context: { enabled: true } });
//   const opinion = await output.minute(report(forwardMetrics.connected, 0));
//   expect(opinion.health).toBe('unhealthy');

/** One metric's point in a minute's batch: a value, or a summary of the minute's samples. */
export interface Report {
  metric: MetricDefinition;
  summary: MetricSummary;
  dimensions: MetricDimensions;
  /** The subject it is about, when not the one judged: the hop before it, read with `metrics.about`. */
  about?: string;
}

/** What a minute's samples were: their mean, and any of their least, greatest and last that differ from it. */
export type Samples = Partial<MetricSummary> & Pick<MetricSummary, 'avg'>;

/** A metric's point in a minute's batch: a minute of samples all equal to `value`. */
export function report(metric: MetricDefinition, value: number, dimensions: MetricDimensions = {}): Report {
  return reportSamples(metric, { avg: value }, dimensions);
}

/** A metric's point in a minute's batch, from samples that varied, such as a brief reconnection. */
export function reportSamples(metric: MetricDefinition, samples: Samples, dimensions: MetricDimensions = {}): Report {
  // Whatever isn't given is the mean, as if every sample were: six samples, one every ten seconds.
  const { avg, min = avg, max = avg, last = avg, count = 6 } = samples;
  return { metric, dimensions, summary: { min, max, avg, last, count } };
}

/** The same point, about another subject: what the reporter says of the hop before the one judged. */
export function about(subjectId: string, point: Report): Report {
  return { ...point, about: subjectId };
}

export interface ReporterOptions<Context> {
  /** What the topology holds of the subject; undefined when it no longer exists. */
  context: Context | undefined;
  subjectId?: string;
}

/** A reporter about one subject, judged by `evaluator` after each minute it reports. */
export function reporter<Context>(evaluator: Evaluator<Context>, options: ReporterOptions<Context>) {
  const store = new MetricStore();
  const subjectId = options.subjectId ?? 'exposure:0199e8b2-0000-7000-8000-000000000000';
  let context = options.context;
  let at = new Date('2026-11-15T12:00:00Z');
  let previous: Opinion | undefined = undefined;
  let consulted: Consulted[] = [];

  return {
    /** Change what the topology holds, such as switching a forward off. */
    set context(next: Context | undefined) {
      context = next;
    },
    /** The metrics the last evaluation read, by name: what its opinion was formed from. */
    get reads(): string[] {
      return consulted.map(({ metric }) => metric);
    },
    /** Report a minute's batch, then judge the subject as of it. */
    async minute(...reports: Report[]): Promise<Opinion> {
      at = new Date(at.getTime() + 60_000);
      for (const point of reports) store.add(point, at);
      const subject: Subject = {
        organisationId: '0199e8b2-0000-7000-8000-00000000000a',
        subjectId,
        entityId: subjectId.slice(subjectId.indexOf(':') + 1),
        reporterId: 'device:0199e8b2-0000-7000-8000-00000000000b',
        at
      };
      const { metrics, reads } = store.as(at);
      previous = await formOpinion(evaluator, { subject, metrics, context, previous }, reads);
      consulted = reads;
      return previous;
    },
    /** Report the same batch for `count` minutes, returning the last opinion. */
    async minutes(count: number, ...reports: Report[]): Promise<Opinion> {
      for (let minute = 1; minute < count; minute++) await this.minute(...reports);
      return this.minute(...reports);
    }
  };
}

/** The opinion's finding of `check`, such as a metric's name, if it has one. */
export function findingOf(opinion: Opinion, check: string): Finding | undefined {
  return opinion.state.findings.find(finding => finding.check === check);
}

interface StoredPoint {
  observedAt: Date;
  summary: MetricSummary;
}

interface StoredSeries {
  seriesId: string;
  /** The subject it is about, when not the one judged. */
  about: string | undefined;
  name: string;
  unit: string;
  dimensions: MetricDimensions;
  points: StoredPoint[];
}

/**
 * The reporter's series in memory, read as `subjectMetrics` reads them from the database: points observed after the
 * window's start and at or before the evaluation's time, summarised per series, the mean weighted by samples.
 */
class MetricStore {
  private readonly series = new Map<string, StoredSeries>();

  add({ metric, dimensions, summary, about }: Report, observedAt: Date) {
    const key = JSON.stringify([about, metric.name, metric.unit, Object.entries(dimensions).sort()]);
    let series = this.series.get(key);
    if (series === undefined) {
      series = {
        seriesId: `series-${this.series.size + 1}`,
        about,
        name: metric.name,
        unit: metric.unit,
        dimensions,
        points: []
      };
      this.series.set(key, series);
    }
    series.points.push({ observedAt, summary });
  }

  /** A `SubjectMetrics` as of `at`, and what it was asked. */
  as(at: Date) {
    const reads: Consulted[] = [];
    const read = (
      subjectId: string | undefined,
      metric: MetricDefinition,
      dimensions: MetricDimensions,
      seconds: number
    ) => {
      const from = at.getTime() - seconds * 1000;
      const readings = this.matching(subjectId, metric, dimensions).flatMap(series => {
        const points = series.points.filter(({ observedAt }) => observedAt.getTime() > from && observedAt <= at);
        const reading = summarised(series, points);
        return reading === undefined ? [] : [reading];
      });
      reads.push({ metric: metric.name, read: seconds, seriesIds: readings.map(({ seriesId }) => seriesId) });
      return readings;
    };
    const metricsAbout = (subjectId: string | undefined): SubjectMetrics => ({
      over: async (metric, seconds, dimensions = {}) => read(subjectId, metric, dimensions, seconds),
      about: metricsAbout
    });
    return { metrics: metricsAbout(undefined), reads };
  }

  private matching(about: string | undefined, metric: MetricDefinition, dimensions: MetricDimensions) {
    const wanted = Object.entries(dimensions);
    return [...this.series.values()].filter(
      series =>
        series.about === about &&
        series.name === metric.name &&
        series.unit === metric.unit &&
        wanted.every(([key, value]) => series.dimensions[key] === value)
    );
  }
}

function summarised(series: StoredSeries, points: StoredPoint[]): Reading | undefined {
  const newest = points.at(-1);
  if (newest === undefined) return undefined;
  const count = points.reduce((sum, { summary }) => sum + summary.count, 0);
  const summary: MetricSummary = {
    min: Math.min(...points.map(({ summary }) => summary.min)),
    max: Math.max(...points.map(({ summary }) => summary.max)),
    avg: points.reduce((sum, { summary }) => sum + summary.avg * summary.count, 0) / count,
    last: newest.summary.last,
    count
  };
  return { seriesId: series.seriesId, dimensions: series.dimensions, observedAt: newest.observedAt, summary };
}
