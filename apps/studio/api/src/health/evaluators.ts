import {
  cameraMetrics,
  channelMetrics,
  formatShare,
  forwardMetrics,
  machineMetrics,
  previewMetrics,
  programMetrics,
  programSubject,
  recorderMetrics,
  type MetricDefinition,
  SUBJECT_KINDS
} from '@conservationtv/reports';
import { and, eq } from 'drizzle-orm';
import { cameras, devices, outputForwards, outputPreviews, outputs } from '../db/schema.ts';
import { useDB } from '../db/transaction.ts';
import { ceiling, evidenceOf, floor, nothingIn, period, share, worstOf } from './checks.ts';
import {
  allOf,
  type Check,
  defineEvaluator,
  type Evaluator,
  hysteresis,
  inactive,
  type Subject,
  verdictOf,
  windowOf
} from './evaluator.ts';
import { evaluateExposure, exposureContext } from './exposure.ts';
import { FINDINGS_LOCALE, type Finding, type Health } from './health.ts';

// The state consumer's opinion of each kind of subject (src/health/consumer.ts): one evaluator per kind that is
// reported about, or `null` for one that isn't judged from its own reports. A stream, an agent or a network is judged
// by its parts, as the organisation's status rolls their health up (src/health/status.ts). Adding a kind to
// `SUBJECT_KINDS` doesn't compile until it is given one or the other.
//
// A subject is judged against what the topology expects of it, which its evaluator's `context` loads: what is switched
// off is `off`, and what nothing is asking for is `idle`, neither of them judged. A hop that only passes on what it is
// given is judged by how much of that it passed on, read from the hop before it, rather than by whether anything at
// all flowed.
//
// Agents submit each subject's summaries every 15 seconds, and each channel's every minute; agents of earlier builds,
// every minute. An opinion holds for three minutes before going stale, three of the slowest intervals, and checks judge
// the last two minutes: eight summaries, or two of a channel's. A subject that was unwell is judged over the last 45
// seconds first, and taken as recovered at once when it is better over them (`formOpinion`, src/health/evaluator.ts):
// otherwise it would stay down for two minutes more however soon it came back. The thresholds are a first opinion, to
// be tuned against what the fleet reports.

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
  return async input => {
    const { metrics } = input;
    const over = windowOf(input, WINDOW);
    // Nothing to judge without both in the window, or a capacity of nothing; otherwise the least free of the greatest
    // capacity, as each was last reported.
    const [frees, totals] = await Promise.all([metrics.over(free, over), metrics.over(total, over)]);
    const worstFree = worstOf(frees, 'last', 'least');
    const worstTotal = worstOf(totals, 'last', 'greatest');
    if (worstFree === undefined || worstTotal === undefined || worstTotal.summary.last <= 0)
      return nothingIn(free, over);
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

/** What a device is, and whether it is switched off, as a camera can be. */
async function deviceContext({ organisationId, entityId }: Subject) {
  const db = useDB({ trusted: true });
  const [device] = await db
    .select({ kind: devices.kind, cameraState: cameras.state })
    .from(devices)
    .leftJoin(cameras, eq(cameras.id, devices.id))
    .where(and(eq(devices.organisationId, organisationId), eq(devices.id, entityId)));
  return device;
}

/** What a device is. */
interface DeviceContext {
  kind: string;
  /** A camera's state; null for any other device. */
  cameraState: string | null;
}

/** An agent's machine: busy, or running out of memory or disk. */
const machineChecks = allOf(
  ceiling(machineMetrics.cpuUtilisation, { over: WINDOW, degradedAbove: 85, unhealthyAbove: 97 }),
  freeShare('Memory', machineMetrics.memoryAvailable, machineMetrics.memoryTotal, {
    unhealthyBelow: 0.03,
    degradedBelow: 0.1
  }),
  freeShare('Disk', machineMetrics.diskFree, machineMetrics.diskTotal, { unhealthyBelow: 0.03, degradedBelow: 0.1 })
);

/** A camera, as an agent on its network probes it: whether it answers, whatever is reading its streams. */
const cameraChecks = allOf(share(cameraMetrics.reachable, { over: WINDOW, unhealthyBelow: 0.5, degradedBelow: 0.99 }));

/**
 * A device: an agent's machine, by what it reports of itself, or a camera, by what an agent's probe of it finds. A
 * camera that is switched off isn't judged.
 */
const device = defineEvaluator<DeviceContext>({
  ttl: TTL,
  context: deviceContext,
  async evaluate(input) {
    if (input.context.kind !== 'camera') return machineChecks(input);
    if (input.context.cameraState !== null && input.context.cameraState !== 'enabled')
      return inactive('off', 'state', 'Switched off');
    return cameraChecks(input);
  }
});

/**
 * One of a stream's deliveries, from the agent whose MediaMTX serves its paths or publishes it to a relay, judged
 * against what is asked of it (src/health/exposure.ts).
 */
const exposure = defineEvaluator({ ttl: TTL, context: exposureContext, evaluate: evaluateExposure });

/** What an output's programme is meant to be: its frame rate, as the output encodes it. */
async function programContext({ organisationId, entityId }: Subject): Promise<ProgramContext | undefined> {
  const db = useDB({ trusted: true });
  const [output] = await db
    .select({ fps: outputs.fps })
    .from(outputs)
    .where(and(eq(outputs.organisationId, organisationId), eq(outputs.id, entityId)));
  return output;
}

/** What an output's programme is meant to be. */
interface ProgramContext {
  /** The frames a second the output encodes at. */
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
  ceiling(programMetrics.reconnecting, { over: WINDOW, of: 'max', unhealthyAbove: 0, whole: true })
);

/**
 * An output's programme: whether `show/program` is ready, and whether OBS is publishing to it, at the output's
 * frame rate, without dropping frames or struggling to send them. On the offline segment, the programme still
 * goes out, so it is degraded rather than unhealthy, and OBS isn't judged.
 */
const program = defineEvaluator({
  ttl: TTL,
  context: programContext,
  // Whether the programme is ready; then whether it was on the offline segment, which is degraded, and if it was
  // throughout, all there is to say; otherwise, OBS's own checks too.
  async evaluate(input) {
    const ready = await share(programMetrics.ready, { over: WINDOW, unhealthyBelow: 0.5, degradedBelow: 0.99 })(input);
    const over = windowOf(input, WINDOW);
    const fallback = await input.metrics.over(programMetrics.fallback, over);
    const mostlyOffline = worstOf(fallback, 'avg', 'greatest');
    const findings: Finding[] = ready === undefined ? [] : [ready];
    if (mostlyOffline !== undefined && mostlyOffline.summary.avg > 0) {
      const value = mostlyOffline.summary.avg;
      findings.push({
        check: programMetrics.fallback.name,
        health: 'degraded',
        summary: `On the offline segment ${formatShare(value, FINDINGS_LOCALE)} of the last ${period(over)}`,
        evidence: [evidenceOf(mostlyOffline, value)]
      });
      // Wholly on the offline segment: OBS isn't publishing, so there is nothing more of it to judge.
      if (mostlyOffline.summary.min === 1) return verdictOf(findings);
    }
    const obs = await obsChecks(input);
    return verdictOf([...findings, ...obs.findings]);
  }
});

/** Whether an output's forward is switched on, and the output it forwards. */
async function forwardContext({ organisationId, entityId }: Subject) {
  const db = useDB({ trusted: true });
  const [forward] = await db
    .select({ enabled: outputForwards.enabled, outputId: outputForwards.outputId })
    .from(outputForwards)
    .where(and(eq(outputForwards.organisationId, organisationId), eq(outputForwards.id, entityId)));
  return forward;
}

/** The output a part of it sends the programme of. */
interface OutputPart {
  outputId: string;
}

/**
 * Whether a part of an output that sends the programme on, a forward or a preview, sent what the programme received:
 * each is sent all of it, so far less is the part falling behind or stalled. Judged by whether it sent anything at all
 * when the reporter says nothing of the programme.
 */
function sendsProgramme(egress: MetricDefinition, label: string): Check<OutputPart> {
  return async input => {
    // Nothing sent is nothing to judge; without the programme's own rate, only whether anything was sent at all;
    // otherwise how much of what the programme received was sent on.
    const over = windowOf(input, WINDOW);
    const program = input.metrics.about(programSubject(input.context.outputId));
    const [sent, received] = await Promise.all([
      input.metrics.over(egress, over),
      program.over(programMetrics.ingestBitrate, over)
    ]);
    const sending = worstOf(sent, 'avg', 'least');
    if (sending === undefined) return nothingIn(egress, over);
    const receiving = worstOf(received, 'avg', 'least');
    if (receiving === undefined || receiving.summary.avg <= 0)
      return floor(egress, { over: WINDOW, unhealthyBelow: 1 })(input);
    const value = sending.summary.avg / receiving.summary.avg;
    const health: Health = value < 0.5 ? 'unhealthy' : value < 0.9 ? 'degraded' : 'healthy';
    const formatted = formatShare(Math.min(1, value), FINDINGS_LOCALE);
    return {
      check: egress.name,
      health,
      summary: `${label} sent ${formatted} of what the programme received in the last ${period(over)}`,
      evidence: [evidenceOf(sending, value)]
    };
  };
}

const forwardChecks = allOf<OutputPart>(
  share(forwardMetrics.connected, { over: WINDOW, unhealthyBelow: 0.5, degradedBelow: 0.99 }),
  sendsProgramme(forwardMetrics.egressBitrate, 'The forward')
);

/** An output's forward to a channel, while it is switched on: whether it is connected to the channel's ingest, sending. */
const forward = defineEvaluator({
  ttl: TTL,
  context: forwardContext,
  async evaluate(input) {
    if (!input.context.enabled) return inactive('off', 'enabled', 'Switched off');
    return forwardChecks(input);
  }
});

/** The output a preview is of. */
async function previewContext({ organisationId, entityId }: Subject) {
  const db = useDB({ trusted: true });
  const [preview] = await db
    .select({ outputId: outputPreviews.outputId })
    .from(outputPreviews)
    .where(and(eq(outputPreviews.organisationId, organisationId), eq(outputPreviews.id, entityId)));
  return preview;
}

/** An output's preview: whether its publisher is reading the programme, and sent what it read. */
const preview = defineEvaluator({
  ttl: TTL,
  context: previewContext,
  evaluate: allOf<OutputPart>(
    share(previewMetrics.connected, { over: WINDOW, unhealthyBelow: 0.5, degradedBelow: 0.99 }),
    sendsProgramme(previewMetrics.egressBitrate, 'The preview')
  )
});

/** An output's recorder: OBS records whenever the output has one, so not recording is a failure. */
const recorder = defineEvaluator({
  ttl: TTL,
  evaluate: allOf(share(recorderMetrics.active, { over: WINDOW, unhealthyBelow: 0.5, degradedBelow: 0.99 }))
});

/** Whether any output's forward to a channel is switched on, so the channel should be live. */
async function channelContext({ organisationId, entityId }: Subject) {
  const db = useDB({ trusted: true });
  const [forwarded] = await db
    .select({ id: outputForwards.id })
    .from(outputForwards)
    .where(
      and(
        eq(outputForwards.organisationId, organisationId),
        eq(outputForwards.channelId, entityId),
        eq(outputForwards.enabled, true)
      )
    )
    .limit(1);
  return { forwarded: forwarded !== undefined };
}

const channelChecks = allOf(share(channelMetrics.live, { over: WINDOW, unhealthyBelow: 0.5, degradedBelow: 0.99 }));

/**
 * A channel an output goes out to, as its platform says: live while a forward sends to it. The platform takes a while to
 * notice a stream starting, so the opinion waits two minutes before taking a worse verdict.
 */
const channel = defineEvaluator({
  ttl: TTL,
  context: channelContext,
  async evaluate(input) {
    if (!input.context.forwarded) return inactive('off', 'forwarded', 'Nothing forwards to it');
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
