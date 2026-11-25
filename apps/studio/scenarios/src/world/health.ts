import {
  channelSubject,
  deviceSubject,
  exposureSubject,
  forwardSubject,
  previewSubject,
  programSubject,
  recorderSubject
} from '@conservationtv/reports';

import { BUILTIN_GATEWAY_ID } from './generate.ts';
import type { CameraRow, GatewayRow, Incident, OutputRow, StateRow, StreamRow, World } from './model.ts';
import type { Rng } from './rng.ts';
import type { OutageKind } from './spec.ts';

// Health over a generated topology. The spec's outages pick root causes (an agent, a camera, a gateway, an output's
// programme, a forward, a channel); each then reaches what depends on it as it would for real: an agent that stops
// reporting leaves everything it reports about stale, a camera that stops answering takes its deliveries down, a
// failing programme takes its forwards with it. On top of that, noise: anything judged may be degraded, go quiet or
// never have reported. What is switched off is `off`; a delivery nothing reads is `idle`.
//
// Only states are made here. What they add up to (failing, affected, off) is the studio API's own rule, run over the
// world by the mock (apps/studio/api/src/health/status.ts), so the status the UI shows is what the API would say.

type Health = StateRow['health'];
type Activity = StateRow['activity'];
type Finding = StateRow['state']['findings'][number];

const WINDOW = '2 min';

interface Judgement {
  health: Health;
  activity: Activity;
  findings: Omit<Finding, 'reporterId' | 'evidence'>[];
  /** Gone quiet: its last report has expired. */
  stale?: boolean;
}

/** One finding a subject reports, before it is attributed to a reporter. */
interface Saying {
  check: string;
  summary: string;
}

/** What each kind of subject says when well, degraded and failing. */
const SAYINGS = {
  agent: {
    healthy: [{ check: 'disk', summary: 'Free disk 62% free' }],
    degraded: [{ check: 'disk', summary: 'Free disk 6% free' }],
    unhealthy: [{ check: 'memory', summary: 'Available memory 1% free' }]
  },
  camera: {
    healthy: [{ check: 'reachable', summary: `Reachable 100% of the last ${WINDOW}` }],
    degraded: [{ check: 'probe', summary: `Probe time 4.2 s (mean of the last ${WINDOW})` }],
    unhealthy: [{ check: 'reachable', summary: `Reachable 0% of the last ${WINDOW}` }]
  },
  exposure: {
    healthy: [{ check: 'ready', summary: `Ready 100% of the last ${WINDOW}` }],
    degraded: [{ check: 'frame-errors', summary: `Ingest frame errors 3.4 frames/s (mean of the last ${WINDOW})` }],
    unhealthy: [{ check: 'ready', summary: `Ready 0% of the last ${WINDOW}` }]
  },
  program: {
    healthy: [{ check: 'ready', summary: `Ready 100% of the last ${WINDOW}` }],
    degraded: [
      { check: 'output-skipped', summary: `Frames skipped encoding 4.1 frames/s (mean of the last ${WINDOW})` }
    ],
    unhealthy: [{ check: 'fallback', summary: `On the offline segment 100% of the last ${WINDOW}` }]
  },
  forward: {
    healthy: [{ check: 'connected', summary: `Connected 100% of the last ${WINDOW}` }],
    degraded: [
      { check: 'egress', summary: `Egress bitrate sent 71% of what the programme received in the last ${WINDOW}` }
    ],
    unhealthy: [{ check: 'connected', summary: `Connected 0% of the last ${WINDOW}` }]
  },
  preview: {
    healthy: [{ check: 'connected', summary: `Connected 100% of the last ${WINDOW}` }],
    degraded: [
      { check: 'egress', summary: `Egress bitrate sent 64% of what the programme received in the last ${WINDOW}` }
    ],
    unhealthy: [{ check: 'connected', summary: `Connected 0% of the last ${WINDOW}` }]
  },
  recorder: {
    healthy: [{ check: 'active', summary: `Recording 100% of the last ${WINDOW}` }],
    degraded: [{ check: 'active', summary: `Recording 82% of the last ${WINDOW}` }],
    unhealthy: [{ check: 'active', summary: `Recording 0% of the last ${WINDOW}` }]
  },
  channel: {
    healthy: [{ check: 'live', summary: `Live 100% of the last ${WINDOW}` }],
    degraded: [{ check: 'live', summary: `Live 90% of the last ${WINDOW}` }],
    unhealthy: [{ check: 'live', summary: `Live 0% of the last ${WINDOW}` }]
  }
} satisfies Record<string, Record<Exclude<Health, 'unknown'>, Saying[]>>;

type Kind = keyof typeof SAYINGS;

function judged(kind: Kind, health: Exclude<Health, 'unknown'>, extra: Partial<Judgement> = {}): Judgement {
  return {
    health,
    activity: 'active',
    findings: SAYINGS[kind][health].map(saying => ({ ...saying, health })),
    ...extra
  };
}

const OFF: Judgement = { health: 'unknown', activity: 'off', findings: [] };
const IDLE: Judgement = { health: 'unknown', activity: 'idle', findings: [] };

/** The root causes picked for a world: the IDs of what is down, by kind, and each in words. */
interface RootCauses {
  agents: Set<string>;
  cameras: Set<string>;
  gateways: Set<string>;
  programs: Set<string>;
  forwards: Set<string>;
  channels: Set<string>;
  incidents: Incident[];
}

/** What judging a world's subjects shares: the world, its root causes, and the states recorded so far. */
interface Assessment {
  world: World;
  rng: Rng;
  now: number;
  down: RootCauses;
  states: StateRow[];
}

/** A forward into a channel: the agent that reports it, and whether anything gets through. */
interface ChannelFeed {
  reporter: string;
  failing: boolean;
}

/** A delivery with the stream it belongs to. */
interface Delivery extends Readonly<StreamRow['exposures'][number]> {
  stream: StreamRow;
}

/** Anything with an ID. */
interface Identified {
  id: string;
}

/** Each candidate down by its chance, plus exactly as many more as the spec names. */
function rootsOf(world: World, rng: Rng, kind: OutageKind, candidates: readonly Identified[]): Set<string> {
  const { health } = world.spec;
  const chosen = new Set(
    candidates
      .filter(candidate => rng.child('outage', kind, candidate.id).chance(health.outages[kind]))
      .map(candidate => candidate.id)
  );
  const rest = candidates.filter(candidate => !chosen.has(candidate.id));
  for (const candidate of rng.child('incidents', kind).sample(rest, health.incidents[kind] ?? 0))
    chosen.add(candidate.id);
  return chosen;
}

/** The root causes, picked kind by kind, with an incident in words for each, in the order the kinds are listed. */
function pickRootCauses(world: World, rng: Rng): RootCauses {
  const deviceName = new Map(world.devices.map(device => [device.id, device.name]));
  const allForwards = world.outputs.flatMap(output => output.forwards.map(forward => ({ ...forward, output })));
  const incidents: Incident[] = [];

  const agents = rootsOf(world, rng, 'agent', world.agents);
  for (const id of agents)
    incidents.push({ subjectId: deviceSubject(id), summary: `Agent ${deviceName.get(id)} stopped reporting` });
  const cameras = rootsOf(
    world,
    rng,
    'camera',
    world.cameras.filter(camera => camera.state !== 'disabled')
  );
  for (const id of cameras)
    incidents.push({ subjectId: deviceSubject(id), summary: `Camera ${deviceName.get(id)} stopped answering` });
  const gateways = rootsOf(world, rng, 'gateway', world.gateways);
  for (const gateway of world.gateways.filter(gateway => gateways.has(gateway.id))) {
    incidents.push({ subjectId: `gateway:${gateway.id}`, summary: `Gateway ${gateway.name} stopped serving` });
  }
  const programs = rootsOf(
    world,
    rng,
    'program',
    world.outputs.filter(output => output.device)
  );
  for (const output of world.outputs.filter(output => programs.has(output.id))) {
    incidents.push({
      subjectId: programSubject(output.id),
      summary: `Output ${output.name} fell back to its offline segment`
    });
  }
  const forwards = rootsOf(
    world,
    rng,
    'forward',
    allForwards.filter(forward => forward.enabled)
  );
  for (const forward of allForwards.filter(forward => forwards.has(forward.id))) {
    incidents.push({
      subjectId: forwardSubject(forward.id),
      summary: `Forward from ${forward.output.name} stopped getting through`
    });
  }
  const channels = rootsOf(world, rng, 'channel', world.channels);
  for (const channel of world.channels.filter(channel => channels.has(channel.id))) {
    incidents.push({
      subjectId: channelSubject(channel.id),
      summary: `Channel ${channel.name} is offline on its platform`
    });
  }
  return { agents, cameras, gateways, programs, forwards, channels, incidents };
}

/** The judgement after the spec's noise: anything active and well may be degraded instead. */
function withNoise(assessment: Assessment, kind: Kind, noise: Rng, judgement: Judgement): Judgement {
  const degrade = judgement.activity === 'active' && judgement.health === 'healthy';
  if (degrade && noise.child('degraded').chance(assessment.world.spec.health.degraded)) return judged(kind, 'degraded');
  return judgement;
}

/**
 * Record a subject's state as reported by `reporter`, with the spec's noise applied, unless nothing reports it. One
 * gone quiet (on its own, by noise, or because its reporter is down) was last heard of minutes ago, and has expired.
 */
function record(assessment: Assessment, kind: Kind, subjectId: string, reporter: string | null, judgement: Judgement) {
  if (!reporter) return;
  const { spec } = assessment.world;
  const noise = assessment.rng.child('noise', subjectId);
  if (noise.child('unreported').chance(spec.health.unreported)) return;
  const result = withNoise(assessment, kind, noise, judgement);
  const stale = result.stale || assessment.down.agents.has(reporter) || noise.child('stale').chance(spec.health.stale);
  const observedAt = stale ? assessment.now - noise.int(8, 95) * 60_000 : assessment.now - noise.int(3, 55) * 1000;
  const reporterId = deviceSubject(reporter);
  assessment.states.push({
    subjectId,
    health: result.health,
    activity: result.activity,
    state: {
      findings: result.findings.map(finding => ({
        ...finding,
        reporterId,
        evidence: [{ seriesId: noise.child('series').uuid(new Date(observedAt)), dimensions: {}, value: noise.float() }]
      }))
    },
    freshness: stale ? 'stale' : 'fresh',
    observedAt: new Date(observedAt).toISOString(),
    expiresAt: new Date(observedAt + 2 * 60_000).toISOString(),
    computedAt: new Date(observedAt + 500).toISOString(),
    contributingReporterIds: [reporterId],
    evidenceReportIds: [noise.child('report').uuid(new Date(observedAt))]
  });
}

/** Failing or not, as a judgement's health. */
const verdict = (failing: boolean) => (failing ? 'unhealthy' : 'healthy');

/**
 * What outputs driven from outside play. The topology doesn't say (their controller picks, and the agent connects to
 * each as OBS plays it), so each one an agent runs plays a few of the relay's deliveries, keyed by the output.
 */
function playedFromOutside(world: World, rng: Rng, deliveries: Delivery[]): string[] {
  const relay = deliveries.filter(delivery => delivery.gatewayId === BUILTIN_GATEWAY_ID);
  return world.outputs
    .filter(output => output.control === 'external' && output.device)
    .flatMap(output => {
      const played = rng.child('played', output.id);
      return played.sample(relay, played.int(Math.min(1, relay.length), Math.min(4, relay.length)));
    })
    .map(delivery => delivery.id);
}

/** Which deliveries are read: placed in a show, played from outside, recorded, or upstream of one that is. */
function readDeliveries(world: World, rng: Rng, deliveries: Delivery[]): Set<string> {
  const placed = new Set([...world.shows.flatMap(show => show.placed), ...playedFromOutside(world, rng, deliveries)]);
  const recorded = new Set(world.streams.flatMap(stream => stream.recorders.map(recorder => recorder.exposureId)));
  const read = new Set<string>();
  for (const delivery of deliveries) {
    // A read delivery, and each one up the chain it is published from.
    if (!placed.has(delivery.id) && !recorded.has(delivery.id)) continue;
    let current: Delivery | undefined = delivery;
    while (current) {
      read.add(current.id);
      const upstreamId: string | null = current.upstreamExposureId;
      current = upstreamId ? deliveries.find(candidate => candidate.id === upstreamId) : undefined;
    }
  }
  return read;
}

/** The active agent on a network, if it has one. */
function activeAgentOf(world: World, networkId: string | null | undefined): string | null {
  if (!networkId) return null;
  return world.networks.find(network => network.id === networkId)?.activeAgent?.id ?? null;
}

/** What a delivery is fed by and through: its camera, its gateway, and the gateway of the delivery it is published from. */
interface DeliveryPath {
  camera: CameraRow | undefined;
  gateway: GatewayRow | undefined;
  upstream: GatewayRow | undefined;
}

/** The camera and gateways a delivery's signal passes through on its way to it. */
function pathOf(world: World, deliveries: Delivery[], delivery: Delivery): DeliveryPath {
  const sourceId = delivery.stream.sourceDeviceId;
  const upstreamId = delivery.upstreamExposureId;
  const upstreamGatewayId = upstreamId
    ? deliveries.find(candidate => candidate.id === upstreamId)?.gatewayId
    : undefined;
  return {
    camera: sourceId ? world.cameras.find(camera => camera.id === sourceId) : undefined,
    gateway: world.gateways.find(gateway => gateway.id === delivery.gatewayId),
    upstream: upstreamId ? world.gateways.find(gateway => gateway.id === (upstreamGatewayId ?? '')) : undefined
  };
}

/** Whether a read delivery is failing: it has no camera, or its camera or either gateway on its path is down. */
function deliveryFailing(down: RootCauses, path: DeliveryPath): boolean {
  if (!path.camera || down.cameras.has(path.camera.id)) return true;
  return [path.gateway, path.upstream].some(gateway => gateway !== undefined && down.gateways.has(gateway.id));
}

/** A delivery's judgement: switched off with its camera, idle while nothing reads it, else judged by what feeds it. */
function deliveryJudgement(down: RootCauses, path: DeliveryPath, isRead: boolean): Judgement {
  if (path.camera?.state === 'disabled') return OFF;
  if (!isRead) return IDLE;
  return judged('exposure', verdict(deliveryFailing(down, path)));
}

/** The network whose active agent runs a delivery: its gateway's, the one it is published from's, or its camera's. */
function deliveryNetwork(path: DeliveryPath): string | null | undefined {
  return path.gateway?.networkId ?? path.upstream?.networkId ?? path.camera?.device?.networkId;
}

/**
 * Judge one delivery, run by the active agent of its network. Returns its camera when something delivers it, as that
 * is a camera that gets probed.
 */
function judgeDelivery(assessment: Assessment, deliveries: Delivery[], read: Set<string>, delivery: Delivery) {
  const path = pathOf(assessment.world, deliveries, delivery);
  const deliverer = activeAgentOf(assessment.world, deliveryNetwork(path));
  const judgement = deliveryJudgement(assessment.down, path, read.has(delivery.id));
  record(assessment, 'exposure', exposureSubject(delivery.id), deliverer, judgement);
  return path.camera && deliverer ? path.camera.id : null;
}

/**
 * Every delivery's state; a stream with no camera and no gateway of its own has nothing to deliver it. Returns the
 * cameras something delivers, which are the ones probed.
 */
function judgeDeliveries(assessment: Assessment): Set<string> {
  const deliveries: Delivery[] = assessment.world.streams.flatMap(stream =>
    stream.exposures.map(exposure => ({ ...exposure, stream }))
  );
  const read = readDeliveries(assessment.world, assessment.rng, deliveries);
  const delivered = new Set<string>();
  for (const delivery of deliveries) {
    const camera = judgeDelivery(assessment, deliveries, read, delivery);
    if (camera) delivered.add(camera);
  }
  return delivered;
}

/** Cameras are probed by the active agent on their network while it delivers one of their streams. */
function judgeCameras(assessment: Assessment, delivered: Set<string>) {
  for (const camera of assessment.world.cameras) {
    // Off when switched off; otherwise failing when it stopped answering.
    const prober = delivered.has(camera.id) ? activeAgentOf(assessment.world, camera.device?.networkId) : null;
    const subjectId = deviceSubject(camera.id);
    if (camera.state === 'disabled') record(assessment, 'camera', subjectId, prober, OFF);
    else
      record(
        assessment,
        'camera',
        subjectId,
        prober,
        judged('camera', verdict(assessment.down.cameras.has(camera.id)))
      );
  }
}

/**
 * The agent running an output reports its programme and everything it sends: a failing programme takes its forwards,
 * previews and recorders with it, and a switched-off forward is off. Notes each forward that reaches a channel.
 */
function judgeOutput(assessment: Assessment, output: OutputRow, channelFeeds: Map<string, ChannelFeed[]>) {
  const reporter = output.device?.deviceId ?? null;
  const programFailing = assessment.down.programs.has(output.id);
  record(assessment, 'program', programSubject(output.id), reporter, judged('program', verdict(programFailing)));
  for (const forward of output.forwards) {
    // Off when switched off; otherwise failing with its programme or on its own, and feeding its channel.
    if (!forward.enabled) {
      record(assessment, 'forward', forwardSubject(forward.id), reporter, OFF);
      continue;
    }
    const failing = programFailing || assessment.down.forwards.has(forward.id);
    record(assessment, 'forward', forwardSubject(forward.id), reporter, judged('forward', verdict(failing)));
    if (!reporter) continue;
    const feeds = channelFeeds.get(forward.channelId) ?? [];
    feeds.push({ reporter, failing });
    channelFeeds.set(forward.channelId, feeds);
  }
  for (const preview of output.previews) {
    record(assessment, 'preview', previewSubject(preview.id), reporter, judged('preview', verdict(programFailing)));
  }
  for (const recorder of output.recorders) {
    record(assessment, 'recorder', recorderSubject(recorder.id), reporter, judged('recorder', verdict(programFailing)));
  }
}

/** Channels are read by an agent forwarding to them; one nothing gets through to isn't live. */
function judgeChannels(assessment: Assessment, channelFeeds: Map<string, ChannelFeed[]>) {
  for (const channel of assessment.world.channels) {
    // Reported by the first agent forwarding to it; down on its own, or when every forward into it is failing.
    const feeds = channelFeeds.get(channel.id) ?? [];
    const reporter = feeds[0]?.reporter ?? null;
    const failing = assessment.down.channels.has(channel.id) || (feeds.length > 0 && feeds.every(feed => feed.failing));
    record(assessment, 'channel', channelSubject(channel.id), reporter, judged('channel', verdict(failing)));
  }
}

export function assignHealth(world: World, rng: Rng): World {
  const down = pickRootCauses(world, rng);
  const assessment: Assessment = { world, rng, now: new Date(world.now).getTime(), down, states: [] };

  // Agents report about themselves; one that stopped reporting was last heard of well.
  for (const agent of world.agents) {
    record(
      assessment,
      'agent',
      deviceSubject(agent.id),
      agent.id,
      judged('agent', 'healthy', { stale: down.agents.has(agent.id) })
    );
  }
  const delivered = judgeDeliveries(assessment);
  judgeCameras(assessment, delivered);
  const channelFeeds = new Map<string, ChannelFeed[]>();
  for (const output of world.outputs) judgeOutput(assessment, output, channelFeeds);
  judgeChannels(assessment, channelFeeds);

  const states = assessment.states.sort((a, b) => (a.subjectId < b.subjectId ? -1 : a.subjectId > b.subjectId ? 1 : 0));
  return { ...world, states, incidents: down.incidents };
}
