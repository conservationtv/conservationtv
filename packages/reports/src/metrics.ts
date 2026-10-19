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
  egressBitrate: { name: 'path.egress.bitrate', unit: 'bits/s', label: 'Egress bitrate' },
  ingestFrameErrors: { name: 'path.ingest.frame_errors', unit: 'frames/s', label: 'Ingest frame errors' }
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
