import {
  channelMetrics,
  formatShare,
  forwardMetrics,
  machineMetrics,
  pathMetrics,
  previewMetrics,
  programMetrics,
  recorderMetrics,
  relayMetrics,
  type MetricDefinition,
  SUBJECT_KINDS
} from '@conservationtv/reports';
import { and, eq } from 'drizzle-orm';
import { showForwards, shows } from '../db/schema.ts';
import { useDB } from '../db/transaction.ts';
import { ceiling, evidenceOf, floor, nothingIn, period, share, worstOf } from './checks.ts';
import {
  allOf,
  type Check,
  defineEvaluator,
  type Evaluator,
  hysteresis,
  type Subject,
  verdictOf
} from './evaluator.ts';
import { FINDINGS_LOCALE, type Finding, type Health } from './health.ts';

// The state consumer's opinion of each kind of subject (src/health/consumer.ts): one evaluator per kind that is
// reported about, or `null` for one that isn't judged from its own reports. A stream, an agent or a network is judged
// by its parts, as the studio's topology rolls their health up. Adding a kind to `SUBJECT_KINDS` doesn't compile until
// it is given one or the other.
//
// Agents submit each subject's summaries every 15 seconds, and each channel's every minute; agents of earlier builds,
// every minute. An opinion holds for three minutes before going stale, three of the slowest intervals, and checks judge
// the last two minutes: eight summaries, or two of a channel's. The thresholds are a first opinion, to be tuned against
// what the fleet reports.

export type SubjectKind = (typeof SUBJECT_KINDS)[number];

/** Seconds of reports a check judges: two of the slowest report intervals. */
const WINDOW = 120;

/**
 * Seconds an opinion holds without a report: three of the slowest report intervals, a channel's or an earlier agent's.
 * Down to a minute or less once every agent reports every 15 seconds, so a subject goes stale sooner.
 */
const TTL = 180;

/** The shares of a capacity free below which a machine is unhealthy, or degraded. */
interface FreeThresholds {
  unhealthyBelow: number;
  degradedBelow: number;
}

/** The free share of a capacity, from two metrics' last values in the window: available memory of memory, free disk of disk. */
function freeShare(
  label: string,
  free: MetricDefinition,
  total: MetricDefinition,
  { unhealthyBelow, degradedBelow }: FreeThresholds
): Check<unknown> {
  return async ({ metrics }) => {
    // Nothing to judge without both in the window, or a capacity of nothing; otherwise the least free of the greatest
    // capacity, as each was last reported.
    const [frees, totals] = await Promise.all([metrics.over(free, WINDOW), metrics.over(total, WINDOW)]);
    const worstFree = worstOf(frees, 'last', 'least');
    const worstTotal = worstOf(totals, 'last', 'greatest');
    if (worstFree === undefined || worstTotal === undefined || worstTotal.summary.last <= 0)
      return nothingIn(free, WINDOW);
    const value = worstFree.summary.last / worstTotal.summary.last;
    const health: Health = value < unhealthyBelow ? 'unhealthy' : value < degradedBelow ? 'degraded' : 'healthy';
    return {
      check: free.name,
      health,
      summary: `${label} ${formatShare(value, FINDINGS_LOCALE)} free`,
      evidence: [evidenceOf(worstFree, value)]
    };
  };
}

/** An agent's machine: busy, or running out of memory or disk. */
const device = defineEvaluator({
  ttl: TTL,
  evaluate: allOf(
    ceiling(machineMetrics.cpuUtilisation, { over: WINDOW, degradedAbove: 85, unhealthyAbove: 97 }),
    freeShare('Memory', machineMetrics.memoryAvailable, machineMetrics.memoryTotal, {
      unhealthyBelow: 0.03,
      degradedBelow: 0.1
    }),
    freeShare('Disk', machineMetrics.diskFree, machineMetrics.diskTotal, { unhealthyBelow: 0.03, degradedBelow: 0.1 })
  )
});

/**
 * One of a stream's deliveries, from the agent whose MediaMTX serves its paths (one per rendition) and publishes it to
 * a relay: whether its paths are ready and receiving, cleanly, and whether the relay receives what the agent publishes.
 */
const exposure = defineEvaluator({
  ttl: TTL,
  evaluate: allOf(
    share(pathMetrics.ready, { over: WINDOW, unhealthyBelow: 0.5, degradedBelow: 0.99 }),
    floor(pathMetrics.ingestBitrate, { over: WINDOW, unhealthyBelow: 1 }),
    ceiling(pathMetrics.ingestFrameErrors, { over: WINDOW, degradedAbove: 0, unhealthyAbove: 5 }),
    floor(relayMetrics.ingestBitrate, { over: WINDOW, unhealthyBelow: 1 })
  )
});

/** What a show's programme is meant to be: its frame rate, as the show encodes it. */
async function programContext({ organisationId, entityId }: Subject): Promise<ProgramContext | undefined> {
  const db = useDB({ trusted: true });
  const [show] = await db
    .select({ fps: shows.fps })
    .from(shows)
    .where(and(eq(shows.organisationId, organisationId), eq(shows.id, entityId)));
  return show;
}

/** What a show's programme is meant to be. */
interface ProgramContext {
  /** The frames a second the show encodes at. */
  fps: number;
}

/** OBS's own health, judged only while it publishes the programme: its frame stats mean nothing otherwise. */
const obsChecks = allOf<ProgramContext>(
  input =>
    floor(programMetrics.fps, {
      over: WINDOW,
      degradedBelow: input.context.fps * 0.9,
      unhealthyBelow: input.context.fps * 0.5
    })(input),
  ceiling(programMetrics.renderSkipped, { over: WINDOW, degradedAbove: 0.5, unhealthyAbove: 5 }),
  ceiling(programMetrics.outputSkipped, { over: WINDOW, degradedAbove: 0.5, unhealthyAbove: 5 }),
  ceiling(programMetrics.congestion, { over: WINDOW, degradedAbove: 0.3, unhealthyAbove: 0.8 }),
  // Any reconnection in the window is unhealthy, however brief: the programme dropped out for viewers. Judged by its
  // greatest sample, so one blip holds the programme unhealthy until it leaves the window, two minutes on, and then
  // for the minute recovery waits; moving to the offline segment doesn't end it sooner, since the blip happened. On
  // purpose: a reconnection is the outage itself, not a sign of one.
  ceiling(programMetrics.reconnecting, { over: WINDOW, of: 'max', unhealthyAbove: 0 })
);

/**
 * A show's programme, from its output: whether `show/program` is ready, and whether OBS is publishing to it, at the
 * show's frame rate, without dropping frames or struggling to send them. On the offline segment, the programme still
 * goes out, so it is degraded rather than unhealthy, and OBS isn't judged.
 */
const program = defineEvaluator({
  ttl: TTL,
  context: programContext,
  // Whether the programme is ready; then whether it was on the offline segment, which is degraded, and if it was
  // throughout, all there is to say; otherwise, OBS's own checks too.
  async evaluate(input) {
    const ready = await share(programMetrics.ready, { over: WINDOW, unhealthyBelow: 0.5, degradedBelow: 0.99 })(input);
    const fallback = await input.metrics.over(programMetrics.fallback, WINDOW);
    const mostlyOffline = worstOf(fallback, 'avg', 'greatest');
    const findings: Finding[] = ready === undefined ? [] : [ready];
    if (mostlyOffline !== undefined && mostlyOffline.summary.avg > 0) {
      const value = mostlyOffline.summary.avg;
      findings.push({
        check: programMetrics.fallback.name,
        health: 'degraded',
        summary: `On the offline segment ${formatShare(value, FINDINGS_LOCALE)} of the last ${period(WINDOW)}`,
        evidence: [evidenceOf(mostlyOffline, value)]
      });
      // Wholly on the offline segment: OBS isn't publishing, so there is nothing more of it to judge.
      if (mostlyOffline.summary.min === 1) return verdictOf(findings);
    }
    const obs = await obsChecks(input);
    return verdictOf([...findings, ...obs.findings]);
  }
});

/** Whether a show's forward is switched on. */
async function forwardContext({ organisationId, entityId }: Subject) {
  const db = useDB({ trusted: true });
  const [forward] = await db
    .select({ enabled: showForwards.enabled })
    .from(showForwards)
    .where(and(eq(showForwards.organisationId, organisationId), eq(showForwards.id, entityId)));
  return forward;
}

const forwardChecks = allOf(
  share(forwardMetrics.connected, { over: WINDOW, unhealthyBelow: 0.5, degradedBelow: 0.99 }),
  floor(forwardMetrics.egressBitrate, { over: WINDOW, unhealthyBelow: 1 })
);

/** A show's forward to a channel, while it is switched on: whether it is connected to the channel's ingest, sending. */
const forward = defineEvaluator({
  ttl: TTL,
  context: forwardContext,
  async evaluate(input) {
    if (!input.context.enabled)
      return verdictOf([{ check: 'enabled', health: 'healthy', summary: 'Switched off', evidence: [] }]);
    return forwardChecks(input);
  }
});

/** A show's preview: whether its publisher is reading the programme, and sent anything. */
const preview = defineEvaluator({
  ttl: TTL,
  evaluate: allOf(
    share(previewMetrics.connected, { over: WINDOW, unhealthyBelow: 0.5, degradedBelow: 0.99 }),
    floor(previewMetrics.egressBitrate, { over: WINDOW, unhealthyBelow: 1 })
  )
});

/** A show's recorder: OBS records whenever the show has one, so not recording is a failure. */
const recorder = defineEvaluator({
  ttl: TTL,
  evaluate: allOf(share(recorderMetrics.active, { over: WINDOW, unhealthyBelow: 0.5, degradedBelow: 0.99 }))
});

/** Whether any show's forward to a channel is switched on, so the channel should be live. */
async function channelContext({ organisationId, entityId }: Subject) {
  const db = useDB({ trusted: true });
  const [forwarded] = await db
    .select({ id: showForwards.id })
    .from(showForwards)
    .where(
      and(
        eq(showForwards.organisationId, organisationId),
        eq(showForwards.channelId, entityId),
        eq(showForwards.enabled, true)
      )
    )
    .limit(1);
  return { forwarded: forwarded !== undefined };
}

const channelChecks = allOf(share(channelMetrics.live, { over: WINDOW, unhealthyBelow: 0.5, degradedBelow: 0.99 }));

/**
 * A channel a show goes out to, as its platform says: live while a forward sends to it. The platform takes a while to
 * notice a stream starting, so the opinion waits two minutes before taking a worse verdict.
 */
const channel = defineEvaluator({
  ttl: TTL,
  context: channelContext,
  async evaluate(input) {
    if (!input.context.forwarded)
      return verdictOf([{ check: 'forwarded', health: 'healthy', summary: 'Nothing forwards to it', evidence: [] }]);
    return channelChecks(input);
  },
  settle: hysteresis({ worsenAfter: 120 })
});

/** Each kind of subject's evaluator, or `null` for one judged by its parts. */
export const evaluators = {
  network: null,
  device,
  agent: null,
  stream: null,
  exposure,
  program,
  forward,
  preview,
  recorder,
  channel
} as const satisfies Record<SubjectKind, Evaluator | null>;

/** The evaluator of the subject's kind, if it is judged by its own reports. */
export function evaluatorOf(subjectId: string): Evaluator | null {
  const prefix = subjectId.slice(0, subjectId.indexOf(':'));
  const kind = SUBJECT_KINDS.find(known => known === prefix);
  if (kind === undefined) return null;
  return evaluators[kind];
}
