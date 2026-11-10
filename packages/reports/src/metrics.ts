import { z } from 'zod';

// Metrics as reporters send them and readers chart them. A series is a metric's name, unit and dimensions about a
// subject, from one reporter; each point in it is a summary of the samples taken over an interval. The studio API stores
// any metric a reporter names: the catalogue below is what the agent ships, so the agent, and whatever shows its
// metrics, agree on each one's name and unit.

/** Metric dimensions, such as a rendition or measurement point. */
export const MetricDimensionsSchema = z.record(z.string().min(1).max(60), z.string().max(200));
export type MetricDimensions = z.output<typeof MetricDimensionsSchema>;

/** What a reporter saw of a metric over an interval: `count` samples, their least, greatest, mean and last values. */
export const MetricSummarySchema = z
  .strictObject({
    min: z.number(),
    max: z.number(),
    avg: z.number(),
    last: z.number(),
    count: z.number().int().min(1)
  })
  .refine(
    ({ min, max, avg, last }) => min <= avg && avg <= max && min <= last && last <= max,
    'A summary’s mean and last value are between its least and greatest.'
  );
export type MetricSummary = z.output<typeof MetricSummarySchema>;

/** Samples taken over an interval, in order, as a summary. Throws when there are none. */
export function summarise(samples: number[]): MetricSummary {
  const count = samples.length;
  if (count === 0) throw new Error('No samples to summarise');
  const total = samples.reduce((sum, sample) => sum + sample, 0);
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const last = samples[count - 1]!;
  // A mean can land a rounding error outside its samples, which the summary's rule refuses.
  const avg = Math.min(max, Math.max(min, total / count));
  return { min, max, avg, last, count };
}

/** A metric a reporter ships: the name and unit its series are stored under, and what to call it. */
export interface MetricDefinition {
  name: string;
  unit: string;
  label: string;
}

/**
 * A MediaMTX path's metrics, summarised from reads every few seconds. About the exposure the path delivers, with the
 * exposure's `rendition` as a dimension when it has several paths, or about the agent's device with the `path` as a
 * dimension when the agent's spec names no paths.
 */
export const pathMetrics = {
  /** 1 while the path is ready, else 0: a summary's mean is the share of its interval the path was ready. */
  ready: { name: 'path.ready', unit: 'boolean', label: 'Ready' },
  readers: { name: 'path.readers', unit: 'readers', label: 'Readers' },
  ingestBitrate: { name: 'path.ingest.bitrate', unit: 'bits/s', label: 'Ingest bitrate' },
  /** What the path sends to readers on the network: every reader but the agent's own MoQ publishers. */
  lanEgressBitrate: { name: 'path.egress.lan.bitrate', unit: 'bits/s', label: 'LAN egress bitrate' },
  /**
   * What the path hands the agent's MoQ publishers, reading it over loopback for a relay. They read all of it for as
   * long as they run, so this is not what reaches the relay: that is `relay.ingest.bitrate`.
   */
  publisherEgressBitrate: { name: 'path.egress.publisher.bitrate', unit: 'bits/s', label: 'Publisher egress bitrate' },
  ingestFrameErrors: { name: 'path.ingest.frame_errors', unit: 'frames/s', label: 'Ingest frame errors' }
} as const satisfies Record<string, MetricDefinition>;

/**
 * What a MoQ relay carries of an exposure the agent publishes there, as the relay counts it in the traffic stats it
 * publishes: about the exposure, summed over its broadcasts and the relay's nodes.
 */
export const relayMetrics = {
  /** What the relay received of the exposure: what actually left the agent for the internet. */
  ingestBitrate: { name: 'relay.ingest.bitrate', unit: 'bits/s', label: 'Relay ingest bitrate' },
  /** What the relay sent on to the exposure's viewers. */
  egressBitrate: { name: 'relay.egress.bitrate', unit: 'bits/s', label: 'Relay egress bitrate' },
  /** Sessions watching the exposure: of its broadcasts, the most watched. */
  viewers: { name: 'relay.viewers', unit: 'sessions', label: 'Relay viewers' }
} as const satisfies Record<string, MetricDefinition>;

/** The machine an agent runs on, and the agent itself, about the agent's device: one sample each per interval. */
export const machineMetrics = {
  cpuCount: { name: 'machine.cpu.count', unit: 'cores', label: 'CPU cores' },
  /** Busy time across every core since the previous sample. */
  cpuUtilisation: { name: 'machine.cpu.utilisation', unit: 'percent', label: 'CPU utilisation' },
  /** The kernel's load average, with its `window` as a dimension. */
  load: { name: 'machine.load', unit: 'processes', label: 'Load average' },
  memoryTotal: { name: 'machine.memory.total', unit: 'bytes', label: 'Memory' },
  memoryFree: { name: 'machine.memory.free', unit: 'bytes', label: 'Free memory' },
  uptime: { name: 'machine.uptime', unit: 'seconds', label: 'Uptime' },
  /** The filesystem the agent's working directory is on. */
  diskTotal: { name: 'machine.disk.total', unit: 'bytes', label: 'Disk' },
  diskFree: { name: 'machine.disk.free', unit: 'bytes', label: 'Free disk' },
  agentMemory: { name: 'agent.memory.rss', unit: 'bytes', label: 'Agent memory' }
} as const satisfies Record<string, MetricDefinition>;

/**
 * A show's program as its output sends it, about `program:<showId>`: the program MediaMTX's `show/program`, which OBS
 * streams to, and OBS itself, as obs-websocket reports it. Summarised from reads every few seconds.
 */
export const programMetrics = {
  /** 1 while `show/program` is ready, else 0. Always available, so ready while the offline segment plays too. */
  ready: { name: 'program.ready', unit: 'boolean', label: 'Ready' },
  /** What `show/program` receives: OBS's stream, or the offline segment while OBS isn't publishing. */
  ingestBitrate: { name: 'program.ingest.bitrate', unit: 'bits/s', label: 'Ingest bitrate' },
  /** 1 while the offline segment plays because OBS isn't publishing, else 0. */
  fallback: { name: 'program.fallback', unit: 'boolean', label: 'On the offline segment' },
  /** The frames a second OBS renders (`GetStats`). */
  fps: { name: 'obs.fps', unit: 'frames/s', label: 'OBS frame rate' },
  /** Frames OBS skipped rendering, as it lagged (`GetStats`). */
  renderSkipped: { name: 'obs.render.skipped', unit: 'frames/s', label: 'Frames skipped rendering' },
  /** Frames OBS skipped encoding, as the encoder lagged (`GetStats`). */
  outputSkipped: { name: 'obs.output.skipped', unit: 'frames/s', label: 'Frames skipped encoding' },
  /** How congested OBS's stream to the program MediaMTX is, from 0 to 1 (`GetStreamStatus`). */
  congestion: { name: 'obs.output.congestion', unit: 'ratio', label: 'Stream congestion' },
  /** 1 while OBS's stream is reconnecting to the program MediaMTX, else 0 (`GetStreamStatus`). */
  reconnecting: { name: 'obs.output.reconnecting', unit: 'boolean', label: 'Reconnecting' }
} as const satisfies Record<string, MetricDefinition>;

/** A show's forward to a channel, about `forward:<forwardId>`: the program MediaMTX's forward of `show/program`. */
export const forwardMetrics = {
  /** What the forward is sent of `show/program`. */
  egressBitrate: { name: 'forward.egress.bitrate', unit: 'bits/s', label: 'Egress bitrate' },
  /** 1 while the forward is connected to the channel's ingest and sending, else 0. */
  connected: { name: 'forward.connected', unit: 'boolean', label: 'Connected' }
} as const satisfies Record<string, MetricDefinition>;

/** A show's preview, about `preview:<previewId>`: what its publisher reads of `show/program` to publish. */
export const previewMetrics = {
  /** What the preview's publisher is sent of `show/program`. */
  egressBitrate: { name: 'preview.egress.bitrate', unit: 'bits/s', label: 'Egress bitrate' },
  /** 1 while the preview's publisher is reading `show/program` to publish it, else 0. */
  connected: { name: 'preview.connected', unit: 'boolean', label: 'Connected' }
} as const satisfies Record<string, MetricDefinition>;

/** A show's recorder, about `recorder:<recorderId>`: OBS recording the program, as `GetRecordStatus` reports it. */
export const recorderMetrics = {
  /** 1 while OBS records, else 0. */
  active: { name: 'recorder.active', unit: 'boolean', label: 'Recording' },
  /** The size of the recording OBS is making, so far. */
  bytes: { name: 'recorder.bytes', unit: 'bytes', label: 'Recorded' }
} as const satisfies Record<string, MetricDefinition>;
