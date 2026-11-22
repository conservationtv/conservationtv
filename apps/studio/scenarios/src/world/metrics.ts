import {
  cameraMetrics,
  channelMetrics,
  forwardMetrics,
  machineMetrics,
  pathMetrics,
  previewMetrics,
  programMetrics,
  recorderMetrics,
  relayMetrics,
  type MetricDefinition
} from '@conservationtv/reports';
import type { MetricQueryV1Output } from '@conservationtv/studio-sdk/versions';

import type { StateRow, World } from './model.ts';
import { Rng } from './rng.ts';

// Metric series made up to match a world's states: a failing subject's readiness drops to nothing partway through the
// range, a degraded one's numbers sag, one gone quiet stops reporting when it did. Keyed by subject and metric, so the
// same query always draws the same lines.

type Series = MetricQueryV1Output['series'][number];

const DEFINITIONS = new Map<string, MetricDefinition>(
  [
    pathMetrics,
    relayMetrics,
    machineMetrics,
    cameraMetrics,
    programMetrics,
    forwardMetrics,
    previewMetrics,
    recorderMetrics,
    channelMetrics
  ].flatMap(group =>
    Object.values(group).map((definition): [string, MetricDefinition] => [definition.name, definition])
  )
);

/** The metric name prefixes each kind of subject is reported with. */
const PREFIXES = new Map(
  Object.entries({
    agent: ['machine.', 'agent.'],
    camera: ['camera.'],
    exposure: ['path.', 'relay.'],
    program: ['program.', 'obs.'],
    forward: ['forward.'],
    preview: ['preview.'],
    recorder: ['recorder.'],
    channel: ['channel.']
  })
);

/** A healthy value for a metric, and how much it wanders. */
interface Baseline {
  value: number;
  spread: number;
}

type BaselineOf = (rng: Rng, definition: MetricDefinition) => Baseline;

const audience: BaselineOf = rng => ({ value: rng.int(1, 240), spread: 0.15 });

/** Each unit's healthy values. */
const BASELINES = new Map(
  Object.entries({
    boolean: () => ({ value: 1, spread: 0 }),
    'bits/s': rng => ({ value: rng.int(2_500_000, 6_500_000), spread: 0.08 }),
    percent: rng => ({ value: rng.int(8, 45), spread: 0.3 }),
    ratio: () => ({ value: 0.02, spread: 0.5 }),
    'frames/s': (_rng, definition) => ({ value: definition.name === 'obs.fps' ? 30 : 0, spread: 0.02 }),
    bytes: rng => ({ value: rng.int(2, 16) * 1_073_741_824, spread: 0.01 }),
    seconds: (rng, definition) => ({
      value: definition.name.endsWith('uptime') ? rng.int(3_600, 2_000_000) : 0.4,
      spread: 0.1
    }),
    viewers: audience,
    readers: audience,
    sessions: audience,
    cores: () => ({ value: 4, spread: 0 })
  } satisfies Record<string, BaselineOf>)
);

/** A healthy value for the metric, by its unit; a unit not listed gets a small count. */
function baseline(rng: Rng, definition: MetricDefinition): Baseline {
  const of = BASELINES.get(definition.unit);
  return of ? of(rng, definition) : { value: rng.int(1, 10), spread: 0.1 };
}

/** Whether a bigger value of the metric is better: what failing or degrading pushes down rather than up. */
function higherIsBetter(definition: MetricDefinition): boolean {
  return !/errors|skipped|congestion|reconnecting|fallback|probe|load|utilisation/u.test(definition.name);
}

/** The range a query covers, in milliseconds, and its bucket in seconds. */
interface MetricRange {
  from: number;
  to: number;
  step: number;
}

/** What a series is drawn from: the metric, the subject's state, and when its trouble set in. */
interface SeriesTrend {
  definition: MetricDefinition;
  state: StateRow;
  baseline: Baseline;
  better: boolean;
  onset: number;
}

/** A reading once trouble has set in: pushed down (or up, where less is better) hard when failing, less when degraded. */
function troubled(trend: SeriesTrend, reading: number): number {
  const { better, definition } = trend;
  if (trend.state.health === 'unhealthy')
    return better ? (definition.unit === 'boolean' ? 0 : reading * 0.02) : reading * 20 + 5;
  if (trend.state.health === 'degraded') return better ? reading * 0.6 : reading * 4 + 2;
  return reading;
}

/** A reading at a time, around the healthy value: nothing much while the subject isn't active, troubled after onset. */
function readingAt(trend: SeriesTrend, at: number, wander: number): number {
  const boolean = trend.definition.unit === 'boolean';
  let reading = trend.baseline.value * (1 + (wander - 0.5) * 2 * trend.baseline.spread);
  if (trend.state.activity !== 'active') reading = boolean ? 0 : reading * 0.05;
  else if (at >= trend.onset) reading = troubled(trend, reading);
  if (boolean) reading = reading >= 0.5 ? 1 : 0;
  return Math.round(reading * 1000) / 1000;
}

/** A point per bucket, until the subject went quiet. */
function pointsOf(rng: Rng, trend: SeriesTrend, range: MetricRange): Series['points'] {
  const quietFrom = trend.state.freshness === 'stale' ? new Date(trend.state.observedAt).getTime() : Infinity;
  const points: Series['points'] = [];
  for (let at = range.from; at < range.to && at <= quietFrom; at += range.step * 1000) {
    const reading = readingAt(trend, at, rng.float());
    points.push({
      at: new Date(at).toISOString(),
      min: reading,
      max: reading,
      avg: reading,
      last: reading,
      count: Math.max(1, Math.round(range.step / 10))
    });
  }
  return points;
}

/** A series of the metric about the subject, if it is a metric there is and something reports about the subject. */
function seriesFor(
  world: World,
  subjectId: string,
  name: string,
  state: StateRow | undefined,
  range: MetricRange
): Series | undefined {
  const definition = DEFINITIONS.get(name);
  const reporterId = state?.contributingReporterIds[0];
  if (!definition || !state || !reporterId) return undefined;
  const rng = new Rng(`metrics/${world.spec.seed}/${subjectId}/${name}`);
  const trend: SeriesTrend = {
    definition,
    state,
    baseline: baseline(rng.child('baseline'), definition),
    better: higherIsBetter(definition),
    // Where in the range a failure or degradation set in.
    onset: range.from + (range.to - range.from) * (0.35 + rng.float() * 0.4)
  };
  return {
    points: pointsOf(rng, trend, range),
    id: rng.child('id').uuid(new Date(range.from)),
    subjectId,
    name,
    reporterId,
    unit: definition.unit,
    dimensions: {},
    createdAt: new Date(range.from).toISOString()
  };
}

/** A metrics query, as `organisations.subjects.metrics.query` takes its body. */
export interface MetricQuery {
  subjectIds: string[];
  names: string[];
  from: string;
  to?: string;
  step?: number;
}

/** The kind of subject an ID names: a device is an agent or a camera. */
function subjectKindOf(world: World, subjectId: string): string {
  const [kind = '', id = ''] = subjectId.split(':');
  if (kind !== 'device') return kind;
  return world.agents.some(agent => agent.id === id) ? 'agent' : 'camera';
}

/** What `organisations.subjects.metrics.query` would return for the query, over the world. */
export function queryMetrics(world: World, query: MetricQuery): MetricQueryV1Output {
  const to = query.to ? new Date(query.to).getTime() : new Date(world.now).getTime();
  const from = new Date(query.from).getTime();
  // As the API does: at least the asked step, widened so the range has at most 1000 buckets.
  const step = Math.max(query.step ?? 60, Math.ceil((to - from) / 1000 / 1000));
  const states = new Map(world.states.map(state => [state.subjectId, state]));
  const series: Series[] = [];
  for (const subjectId of query.subjectIds) {
    // Only the metrics this kind of subject is reported with.
    const prefixes = PREFIXES.get(subjectKindOf(world, subjectId)) ?? [];
    for (const name of query.names.filter(wanted => prefixes.some(prefix => wanted.startsWith(prefix)))) {
      const made = seriesFor(world, subjectId, name, states.get(subjectId), { from, to, step });
      if (made) series.push(made);
    }
  }
  return { series, from: new Date(from).toISOString(), to: new Date(to).toISOString(), step };
}
