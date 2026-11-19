import { formatMetric, formatShare, pathMetrics, relayMetrics } from '@conservationtv/reports';
import { and, eq } from 'drizzle-orm';
import { cameras, exposures, streams } from '../db/schema.ts';
import { useDB } from '../db/transaction.ts';
import { evidenceOf, period } from './checks.ts';
import {
  type EvaluationInput,
  inactive,
  type Subject,
  unknownFinding,
  type Verdict,
  verdictOf,
  windowOf
} from './evaluator.ts';
import { FINDINGS_LOCALE, type Finding, type Health, isWorse } from './health.ts';
import type { Reading } from './metrics.ts';

// An exposure's opinion: one of a stream's deliveries, from the agent whose MediaMTX serves its paths (one per
// rendition), or publishes it to a relay. Neither is judged by what flows, since both only carry what is asked for:
// MediaMTX pulls a path from its camera only while it is read, and a relay asks a publisher only for what viewers
// take. So each is judged by what says whether it would deliver:
//
//   a path      for the share of the window it was asked for: all of it when a publisher is planned to read the
//               rendition (so a publisher that died is a failure, not a path gone idle), otherwise while it had
//               readers. Then whether it was ready for that share, received anything, cleanly, and whether its
//               publisher read what it received;
//   the relay   by whether it has each rendition to give: its broadcast announced there, and its catalog read back
//               through the relay by the agent. That holds whether or not anyone watches, so a published exposure is
//               never idle. How much the relay carries, and for how many, is charted, not judged: it is how much is
//               watched.
//
// A path nothing asked for isn't judged. An exposure of only such paths is `idle`; one whose camera is switched off is
// `off`.

/** Seconds of reports judged: as the other evaluators' (src/health/evaluators.ts). */
const WINDOW = 120;

/** The least share of the window something must be asked for to be judged: a reader that only just arrived isn't. */
const MIN_DEMAND = 0.25;

/** What the topology expects of an exposure. */
export interface ExposureContext {
  /** Its renditions. */
  renditions: string[];
  /** Those of its renditions an exposure downstream is published from: read by a publisher for as long as it runs. */
  published: string[];
  /** The exposure it is published from, if it is. */
  upstreamExposureId: string | null;
  /** Whether its stream's camera is switched off. */
  sourceOff: boolean;
}

/** What the topology expects of the exposure; undefined once it is gone. */
export async function exposureContext({ organisationId, entityId }: Subject): Promise<ExposureContext | undefined> {
  const db = useDB({ trusted: true });
  const [exposure] = await db
    .select({
      streamId: exposures.streamId,
      renditions: exposures.renditions,
      upstreamExposureId: exposures.upstreamExposureId,
      cameraState: cameras.state
    })
    .from(exposures)
    .innerJoin(streams, eq(streams.id, exposures.streamId))
    .leftJoin(cameras, eq(cameras.id, streams.sourceDeviceId))
    .where(and(eq(exposures.organisationId, organisationId), eq(exposures.id, entityId)));
  if (exposure === undefined) return undefined;
  const downstream = await db
    .select({ renditions: exposures.renditions })
    .from(exposures)
    .where(and(eq(exposures.organisationId, organisationId), eq(exposures.upstreamExposureId, entityId)));
  const read = new Set(downstream.flatMap(each => each.renditions));
  return {
    renditions: exposure.renditions,
    published: exposure.renditions.filter(rendition => read.has(rendition)),
    upstreamExposureId: exposure.upstreamExposureId,
    sourceOff: exposure.cameraState !== null && exposure.cameraState !== 'enabled'
  };
}

/** One hop's findings, and whether anything asked for it: undefined when nothing was reported of it. */
interface Part {
  demanded: boolean;
  findings: Finding[];
}

/** What a part is judged from: the reporter's metrics, what the topology expects, and the seconds back to judge. */
interface Judged {
  metrics: EvaluationInput<ExposureContext>['metrics'];
  context: ExposureContext;
  window: number;
}

export async function evaluateExposure(input: EvaluationInput<ExposureContext>): Promise<Verdict> {
  // Off before anything else; then each hop that reported, judged only where something asked for it. With none
  // reporting there is nothing to judge by, and with none asked for the exposure is idle.
  if (input.context.sourceOff) return inactive('off', 'source', 'Its camera is switched off');
  const judged: Judged = { metrics: input.metrics, context: input.context, window: windowOf(input, WINDOW) };
  const paths = await pathPart(judged);
  const relay = await relayPart(judged);
  const parts = [paths, relay].filter(part => part !== undefined);
  if (parts.length === 0)
    return verdictOf([unknownFinding('reports', `Nothing reported in the last ${period(judged.window)}`)]);
  const demanded = parts.filter(part => part.demanded);
  if (demanded.length === 0) return inactive('idle', 'demand', 'Idle: nothing is reading it');
  return verdictOf(demanded.flatMap(part => part.findings));
}

/** A share, clamped to what a share can be. */
function share(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** The worse of two findings of one check; the first when neither is. */
function worse(current: Finding | undefined, candidate: Finding): Finding {
  if (current === undefined) return candidate;
  return isWorse(candidate.health, current.health) ? candidate : current;
}

/** Each check's worst finding, of several renditions'. */
function worstOfEach(findings: Finding[]): Finding[] {
  const worst = new Map<string, Finding>();
  for (const finding of findings) worst.set(finding.check, worse(worst.get(finding.check), finding));
  return [...worst.values()];
}

/** Each rendition's reading of a metric: a path without the dimension is the exposure's only one. */
function byRendition(readings: Reading[]): Map<string, Reading> {
  return new Map(readings.map(reading => [reading.dimensions.rendition ?? '', reading]));
}

/** What the reporter said of the exposure's paths over the window, each metric by rendition. */
interface PathReadings {
  ready: Map<string, Reading>;
  read: Map<string, Reading>;
  readers: Map<string, Reading>;
  ingest: Map<string, Reading>;
  errors: Map<string, Reading>;
  publisher: Map<string, Reading>;
}

async function pathReadings({ metrics, window }: Judged): Promise<PathReadings> {
  const [ready, read, readers, ingest, errors, publisher] = await Promise.all([
    metrics.over(pathMetrics.ready, window),
    metrics.over(pathMetrics.read, window),
    metrics.over(pathMetrics.readers, window),
    metrics.over(pathMetrics.ingestBitrate, window),
    metrics.over(pathMetrics.ingestFrameErrors, window),
    metrics.over(pathMetrics.publisherEgressBitrate, window)
  ]);
  return {
    ready: byRendition(ready),
    read: byRendition(read),
    readers: byRendition(readers),
    ingest: byRendition(ingest),
    errors: byRendition(errors),
    publisher: byRendition(publisher)
  };
}

/** Whether a publisher is planned to read the rendition. A path that names none is the exposure's only one. */
function isPublished(rendition: string, { published }: ExposureContext): boolean {
  return rendition === '' ? published.length > 0 : published.includes(rendition);
}

/**
 * The share of the window a rendition was asked for. All of it when a publisher is planned to read it, whether or not
 * the publisher is there; otherwise for as long as it was read. An agent that doesn't say is taken to be read while it
 * had readers, and one that says neither is judged as it always was.
 */
function demandFor(rendition: string, readings: PathReadings, context: ExposureContext): number {
  if (isPublished(rendition, context)) return 1;
  const asked = readings.read.get(rendition) ?? readings.readers.get(rendition);
  return asked === undefined ? 1 : share(asked.summary.avg);
}

/** A rendition, and the share of the window it was asked for. */
interface Asked {
  rendition: string;
  demand: number;
}

/** One rendition's findings, for the share of the window it was asked for. */
function renditionFindings({ rendition, demand }: Asked, readings: PathReadings, { context, window }: Judged) {
  const findings: Finding[] = [];
  const ready = readings.ready.get(rendition);
  if (ready !== undefined) findings.push(readyFinding(ready, demand, window));
  const received = readings.ingest.get(rendition);
  if (received !== undefined) findings.push(ingestFinding(received, window));
  const erring = readings.errors.get(rendition);
  if (erring !== undefined) findings.push(errorsFinding(erring, window));
  // A publisher reads all a path receives, so only what it receives says how much that should be.
  const sent = isPublished(rendition, context) ? readings.publisher.get(rendition) : undefined;
  const flowing = received !== undefined && received.summary.avg > 0;
  if (sent !== undefined && flowing) findings.push(publisherFinding(sent, received, window));
  return findings;
}

/**
 * The paths' findings: each check's worst rendition, of those asked for. Undefined when no path reported being ready
 * or not, as for an exposure this reporter only publishes.
 */
async function pathPart(judged: Judged): Promise<Part | undefined> {
  const readings = await pathReadings(judged);
  if (readings.ready.size === 0) return undefined;
  const asked = [...readings.ready.keys()]
    .map((rendition): Asked => ({ rendition, demand: demandFor(rendition, readings, judged.context) }))
    .filter(({ demand }) => demand >= MIN_DEMAND);
  const findings = asked.flatMap(each => renditionFindings(each, readings, judged));
  return { demanded: asked.length > 0, findings: worstOfEach(findings) };
}

/** Whether the path was ready for as much of the window as it was asked for. */
function readyFinding(reading: Reading, demand: number, window: number): Finding {
  const value = share(reading.summary.avg / demand);
  const throughout = demand === 1;
  // Starting up when a reader arrives takes a moment, which a path read throughout never has to.
  const degradedBelow = throughout ? 0.99 : 0.8;
  const health: Health = value < 0.5 ? 'unhealthy' : value < degradedBelow ? 'degraded' : 'healthy';
  const label = pathMetrics.ready.label;
  const formatted = formatShare(value, FINDINGS_LOCALE);
  const summary = throughout
    ? `${label} ${formatted} of the last ${period(window)}`
    : `${label} ${formatted} of the time it was read in the last ${period(window)}`;
  return { check: pathMetrics.ready.name, health, summary, evidence: [evidenceOf(reading, value)] };
}

/** Whether the path received anything from its source. */
function ingestFinding(reading: Reading, window: number): Finding {
  const metric = pathMetrics.ingestBitrate;
  const value = reading.summary.avg;
  const formatted = formatMetric(value, metric.unit, FINDINGS_LOCALE);
  return {
    check: metric.name,
    health: value < 1 ? 'unhealthy' : 'healthy',
    summary: `${metric.label} ${formatted} (mean of the last ${period(window)})`,
    evidence: [evidenceOf(reading, value)]
  };
}

/** Whether what the path received was damaged. */
function errorsFinding(reading: Reading, window: number): Finding {
  const metric = pathMetrics.ingestFrameErrors;
  const value = reading.summary.avg;
  const formatted = formatMetric(value, metric.unit, FINDINGS_LOCALE);
  return {
    check: metric.name,
    health: value > 5 ? 'unhealthy' : value > 0 ? 'degraded' : 'healthy',
    summary: `${metric.label} ${formatted} (mean of the last ${period(window)})`,
    evidence: [evidenceOf(reading, value)]
  };
}

/** Whether the rendition's publisher read what the path received: a publisher reads all of it, for as long as it runs. */
function publisherFinding(sent: Reading, received: Reading, window: number): Finding {
  const value = sent.summary.avg / received.summary.avg;
  const health: Health = value < 0.5 ? 'unhealthy' : value < 0.9 ? 'degraded' : 'healthy';
  const formatted = formatShare(share(value), FINDINGS_LOCALE);
  return {
    check: pathMetrics.publisherEgressBitrate.name,
    health,
    summary: `Its publisher read ${formatted} of what the path received in the last ${period(window)}`,
    evidence: [evidenceOf(sent, value)]
  };
}

/** Whether the relay had a rendition to give for the window: announced there, its catalog read back. */
function announcedFinding(reading: Reading, window: number): Finding {
  const value = reading.summary.avg;
  const health: Health = value < 0.5 ? 'unhealthy' : value < 0.99 ? 'degraded' : 'healthy';
  const formatted = formatShare(value, FINDINGS_LOCALE);
  return {
    check: relayMetrics.announced.name,
    health,
    summary: `${relayMetrics.announced.label} ${formatted} of the last ${period(window)}`,
    evidence: [evidenceOf(reading, value)]
  };
}

/**
 * The relay's finding: whether it had the exposure's renditions to give, by the worst of them. Undefined when nothing
 * was reported of the relay, as for an exposure that isn't published. An agent from before it said whether the relay
 * has a rendition reports only what the relay carried, which says how much was watched, not whether it works: then
 * there is nothing to judge by.
 */
async function relayPart({ metrics, window }: Judged): Promise<Part | undefined> {
  const [announced, carried] = await Promise.all([
    metrics.over(relayMetrics.announced, window),
    metrics.over(relayMetrics.ingestBitrate, window)
  ]);
  if (announced.length > 0) {
    const findings = announced.map(reading => announcedFinding(reading, window));
    return { demanded: true, findings: worstOfEach(findings) };
  }
  if (carried.length === 0) return undefined;
  const summary = "Its agent doesn't say whether the relay has it";
  return { demanded: true, findings: [unknownFinding(relayMetrics.announced.name, summary)] };
}
