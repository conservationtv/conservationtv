import {
  formatMetric,
  formatSeconds,
  formatShare,
  type MetricDefinition,
  type MetricDimensions,
  type MetricSummary
} from '@conservationtv/reports';
import type { Check } from './evaluator.ts';
import { type Evidence, FINDINGS_LOCALE, type Finding, type Health } from './health.ts';
import type { Reading } from './metrics.ts';

// Checks evaluators are made of (src/health/evaluators.ts): each reads one metric over a window and judges it against
// thresholds. A metric can have several series about one subject, such as an exposure's renditions; a check judges
// the worst of them and cites it. A metric with no points in the window can't be judged: the finding is `unknown`,
// which never outweighs a judgement.

/** Which of a summary's values a check judges. */
export type Statistic = keyof Omit<MetricSummary, 'count'>;

const STATISTIC_WORDS = { min: 'least', max: 'most', avg: 'mean', last: 'last' } satisfies Record<Statistic, string>;

export interface ShareOptions {
  /** Seconds back to judge. */
  over: number;
  /** Unhealthy when it held for less of the window than this, from 0 to 1. */
  unhealthyBelow?: number;
  /** Degraded when it held for less of the window than this. */
  degradedBelow?: number;
  dimensions?: MetricDimensions;
}

/**
 * How much of the window a `boolean` metric held: its samples' mean, of the series that held least. `Ready 62% of the
 * last 2 min`.
 */
export function share(metric: MetricDefinition, options: ShareOptions): Check<unknown> {
  const { over, unhealthyBelow, degradedBelow, dimensions } = options;
  return async ({ metrics }) => {
    const readings = await metrics.over(metric, over, dimensions);
    const worst = worstOf(readings, 'avg', 'least');
    if (worst === undefined) return nothingIn(metric, over);
    const value = worst.summary.avg;
    const health = below(value, unhealthyBelow, degradedBelow);
    const summary = `${metric.label} ${formatShare(value, FINDINGS_LOCALE)} of the last ${period(over)}`;
    return { check: metric.name, health, summary, evidence: [evidenceOf(worst, value)] };
  };
}

export interface ThresholdOptions {
  /** Seconds back to judge. */
  over: number;
  /** Which of the window's values to judge: its mean by default. */
  of?: Statistic;
  dimensions?: MetricDimensions;
}

export interface CeilingOptions extends ThresholdOptions {
  degradedAbove?: number;
  unhealthyAbove?: number;
}

/** A metric that should stay low, such as dropped frames: judged by the series that went highest. */
export function ceiling(metric: MetricDefinition, options: CeilingOptions): Check<unknown> {
  const { over, of = 'avg', degradedAbove, unhealthyAbove, dimensions } = options;
  return async ({ metrics }) => {
    const readings = await metrics.over(metric, over, dimensions);
    const worst = worstOf(readings, of, 'greatest');
    if (worst === undefined) return nothingIn(metric, over);
    const value = worst.summary[of];
    const health = above(value, unhealthyAbove, degradedAbove);
    return {
      check: metric.name,
      health,
      summary: described(metric, of, value, over),
      evidence: [evidenceOf(worst, value)]
    };
  };
}

export interface FloorOptions extends ThresholdOptions {
  degradedBelow?: number;
  unhealthyBelow?: number;
}

/** A metric that should stay high, such as a bitrate: judged by the series that went lowest. */
export function floor(metric: MetricDefinition, options: FloorOptions): Check<unknown> {
  const { over, of = 'avg', degradedBelow, unhealthyBelow, dimensions } = options;
  return async ({ metrics }) => {
    const readings = await metrics.over(metric, over, dimensions);
    const worst = worstOf(readings, of, 'least');
    if (worst === undefined) return nothingIn(metric, over);
    const value = worst.summary[of];
    const health = below(value, unhealthyBelow, degradedBelow);
    return {
      check: metric.name,
      health,
      summary: described(metric, of, value, over),
      evidence: [evidenceOf(worst, value)]
    };
  };
}

/** A finding of nothing to judge `metric` by in the window. */
export function nothingIn(metric: MetricDefinition, over: number): Finding {
  return {
    check: metric.name,
    health: 'unknown',
    summary: `${metric.label}: nothing reported in the last ${period(over)}`,
    evidence: []
  };
}

/** The series whose `statistic` is the least or greatest, if any. */
export function worstOf(readings: Reading[], statistic: Statistic, worst: 'least' | 'greatest') {
  let found: Reading | undefined = undefined;
  for (const reading of readings) {
    if (found === undefined) found = reading;
    const value = reading.summary[statistic];
    const current = found.summary[statistic];
    if (worst === 'least' ? value < current : value > current) found = reading;
  }
  return found;
}

export function evidenceOf({ seriesId, dimensions }: Reading, value: number): Evidence {
  return { seriesId, dimensions, value };
}

// The worse threshold first: below both is unhealthy, below only the milder degraded, and either may be unset.
function below(value: number, unhealthyBelow: number | undefined, degradedBelow: number | undefined): Health {
  if (unhealthyBelow !== undefined && value < unhealthyBelow) return 'unhealthy';
  if (degradedBelow !== undefined && value < degradedBelow) return 'degraded';
  return 'healthy';
}

// The worse threshold first: above both is unhealthy, above only the milder degraded, and either may be unset.
function above(value: number, unhealthyAbove: number | undefined, degradedAbove: number | undefined): Health {
  if (unhealthyAbove !== undefined && value > unhealthyAbove) return 'unhealthy';
  if (degradedAbove !== undefined && value > degradedAbove) return 'degraded';
  return 'healthy';
}

/** `Ingest bitrate 2.4 Mb/s (mean of the last 2 min)`. */
function described(metric: MetricDefinition, of: Statistic, value: number, over: number) {
  const formatted = formatMetric(value, metric.unit, FINDINGS_LOCALE);
  return `${metric.label} ${formatted} (${STATISTIC_WORDS[of]} of the last ${period(over)})`;
}

/** A window of seconds, as findings write it: `2 min`. */
export function period(seconds: number): string {
  return formatSeconds(seconds, FINDINGS_LOCALE);
}
