import { cameraMetrics } from '@conservationtv/reports';
import type { BehaviorSubject } from 'rxjs';
import { z } from 'zod';
import { type Journal, useJournal } from '../reporting/journal.ts';
import { type IntervalSamples, Sampler, type SamplerStatus } from '../reporting/sampler.ts';
import { describeStream } from './rtsp.ts';

// The `probes` key: whether each camera the agent's streams come from is there, asked every interval whether or not
// anything reads it (rtsp.ts). MediaMTX pulls a camera only while one of its paths is read, so a camera nobody is
// watching would otherwise be gone without anything saying so. Each answer is a sample of `camera.reachable` about the
// camera's device, and how long it took when it came; a camera that stops answering, or starts again, is an event
// about it too, saying why (`camera.unreachable`, `camera.reachable`).

/** A camera to probe: the URL to ask for a stream description, credentials included, and what it is reported about. */
const ProbeSchema = z.object({ subjectId: z.string(), url: z.url() });
type Probe = z.output<typeof ProbeSchema>;

export const ProbesSpecSchema = z.object({
  /** How often each camera is asked, and its answer reported. */
  intervalMs: z.number().int().min(5_000),
  cameras: z.array(ProbeSchema)
});
export type ProbesSpec = z.output<typeof ProbesSpecSchema>;

/** How long a camera has to answer. */
const TIMEOUT_MS = 4_000;

/** What probing adds to its sampler's status. */
interface ProbeReads {
  /** How many cameras are probed. */
  cameras: number;
  /** The subjects of those that did not answer last time, each with why. */
  unreachable: Record<string, string>;
  /** ISO 8601. */
  lastProbedAt: string | null;
}

export type ProbesStatus = SamplerStatus & ProbeReads;

/** Asks each camera whether it is there, and reports what it says about the camera's device. */
export class CameraProbeRuntime {
  readonly status$: BehaviorSubject<ProbesStatus>;
  private readonly sampler: Sampler<ProbeReads>;
  private readonly journal: Journal;
  private cameras: Probe[] = [];
  private intervalMs = 0;
  /** Why each camera that did not answer last time didn't, by subject: what a change is told from. */
  private unreachable = new Map<string, string>();
  /** The subjects probed at least once since the spec named them: a first answer is news only when it is bad. */
  private probed = new Set<string>();

  constructor() {
    this.journal = useJournal();
    this.sampler = new Sampler<ProbeReads>({
      stopped: { cameras: 0, unreachable: {}, lastProbedAt: null },
      sample: samples => this.sample(samples),
      target: subjectId => ({ subjectId, dimensions: {} })
    });
    this.status$ = this.sampler.status$;
  }

  /** Probe the spec's cameras, every interval, from now on. Only a changed interval starts the timer afresh. */
  async apply(spec: ProbesSpec): Promise<void> {
    this.cameras = spec.cameras;
    const named = new Set(spec.cameras.map(camera => camera.subjectId));
    for (const subjectId of this.unreachable.keys()) if (!named.has(subjectId)) this.unreachable.delete(subjectId);
    this.probed = new Set([...this.probed].filter(subjectId => named.has(subjectId)));
    this.sampler.update({ cameras: spec.cameras.length, unreachable: Object.fromEntries(this.unreachable) });
    if (spec.cameras.length === 0) return this.teardown();
    if (this.sampler.running && spec.intervalMs === this.intervalMs) return;
    this.intervalMs = spec.intervalMs;
    this.sampler.start({ sampleMs: spec.intervalMs, reportMs: spec.intervalMs });
  }

  /** Stop probing, and drop what was not submitted. Safe when it never started. */
  async teardown(): Promise<void> {
    this.cameras = [];
    this.unreachable.clear();
    this.probed.clear();
    this.sampler.stop();
    this.sampler.update({ cameras: 0, unreachable: {} });
  }

  /** Stop the timer for good when the agent stops; not a removal, so the status is left as it was. */
  dispose(): void {
    this.sampler.dispose();
  }

  /** Ask every camera at once, and sample what each said. */
  private async sample(samples: IntervalSamples): Promise<void> {
    await Promise.all(this.cameras.map(camera => this.probe(camera, samples)));
    const now = new Date();
    this.sampler.update({ unreachable: Object.fromEntries(this.unreachable), lastProbedAt: now.toISOString() });
  }

  private async probe({ subjectId, url }: Probe, samples: IntervalSamples): Promise<void> {
    const described = await describeStream(url, AbortSignal.timeout(TIMEOUT_MS));
    samples.add(subjectId, cameraMetrics.reachable, described.ok ? 1 : 0);
    if (described.ok) samples.add(subjectId, cameraMetrics.probeDuration, described.seconds);
    const before = this.unreachable.get(subjectId);
    const first = !this.probed.has(subjectId);
    this.probed.add(subjectId);
    if (described.ok) {
      this.unreachable.delete(subjectId);
      if (before !== undefined) this.journal.event('camera.reachable', {}, subjectId);
      return;
    }
    this.unreachable.set(subjectId, described.reason);
    // Said when it stops answering, and again when why changes; not every time it still doesn't.
    if (first || before !== described.reason)
      this.journal.event('camera.unreachable', { reason: described.reason }, subjectId);
  }
}
