import { Client, DeviceIdentity, deviceSignature, type PostReportsData } from '@conservationtv/studio-sdk';
import { BehaviorSubject } from 'rxjs';
import type { AgentConfiguration } from '../config.ts';
import { MEDIAMTX_METRICS_ADDRESS } from './mediamtx-config.ts';

type Report = Extract<PostReportsData['body']['reports'][number], Record<'kind', 'metric'>>;
type Metric = Report['payload'];
interface PendingMetric {
  observedAt: string;
  payload: Metric;
}
interface Studio {
  client: Client;
  subjectId: string;
}
export interface MediamtxMetricsStatus {
  enabled: boolean;
  subjectId: string | null;
  pending: number;
  submitted: number;
  lastSampledAt: string | null;
  lastSubmittedAt: string | null;
  lastError: string | null;
}

/** MediaMTX v1.21.2 emits untyped Prometheus samples. Keep its names and labels, namespaced for the studio. */
export function parseMediamtxMetrics(text: string): Metric[] {
  const metrics: Metric[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)\s*$/.exec(line);
    if (match === null) throw new Error(`Invalid MediaMTX metric: ${line}`);
    const [, name, labels, raw] = match;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue; // The studio accepts finite samples only.
    const dimensions = parseLabels(labels ?? '');
    metrics.push({ name: `mediamtx.${name}`, value, dimensions, ...measurement(name!) });
  }
  return metrics;
}

// Decode Prometheus escapes and reject oversized labels before they can poison a submission batch.
function parseLabels(text: string) {
  const labels: Record<string, string> = {};
  const pattern = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\[\\"n])*)"(?:,|$)/gy;
  let offset = 0;
  while (offset < text.length) {
    const match = pattern.exec(text);
    if (match === null) throw new Error('Invalid MediaMTX metric labels');
    const [, key, encoded] = match;
    const value = encoded!.replace(/\\([\\"n])/g, (_escape, character: string) =>
      character === 'n' ? '\n' : character
    );
    if (key!.length > 60 || value.length > 200) throw new Error('MediaMTX metric label exceeds studio limits');
    labels[key!] = value;
    offset = pattern.lastIndex;
  }
  return labels;
}

/** Cumulative traffic/error counts are counters; connection counts, buffers, rates and jitter are gauges. */
function measurement(name: string): Pick<Metric, 'type' | 'unit'> {
  if (name.includes('_mbps_')) return { type: 'gauge', unit: 'megabits/second' };
  if (name.includes('_ms_')) return { type: 'gauge', unit: 'milliseconds' };
  if (name.includes('_us_')) return { type: name.endsWith('_duration') ? 'counter' : 'gauge', unit: 'microseconds' };
  if (name.endsWith('_jitter')) return { type: 'gauge', unit: 'seconds' };
  if (name.endsWith('_avg_belated_time')) return { type: 'gauge', unit: 'milliseconds' };
  if (name.endsWith('_loss_rate')) return { type: 'gauge', unit: null };
  const counter =
    /_(?:bytes|packets|frames)(?:_(?:received|sent|in_error|lost|discarded|reported_lost|retrans|send_drop|send_loss).*)?$/.test(
      name
    );
  const unit = name.includes('_bytes') ? 'bytes' : null;
  return { type: counter ? 'counter' : 'gauge', unit };
}

/** Bounded, retryable batches, signed by the agent's device, just like the machine metrics runtime. */
export class MediamtxMetrics {
  readonly status$ = new BehaviorSubject<MediamtxMetricsStatus>({
    enabled: false,
    subjectId: null,
    pending: 0,
    submitted: 0,
    lastSampledAt: null,
    lastSubmittedAt: null,
    lastError: null
  });
  private timer: ReturnType<typeof setInterval> | undefined = undefined;
  private session: AbortController | undefined = undefined;
  private pending: PendingMetric[] = [];
  private studio: Studio | undefined = undefined;

  constructor(private readonly config: AgentConfiguration) {}

  start(intervalMs: number): void {
    this.stop();
    if (this.config.type === 'direct') return;
    const session = new AbortController();
    this.session = session;
    this.update({ enabled: true });
    // A chained timeout keeps slow requests from overlapping the next scrape.
    const tick = async () => {
      await this.tick(session.signal);
      if (!session.signal.aborted) this.timer = setTimeout(() => void tick(), intervalMs);
    };
    void tick();
  }

  stop(): void {
    clearTimeout(this.timer);
    this.session?.abort();
    this.session = undefined;
    this.studio = undefined;
    this.pending = [];
    this.update({ enabled: false, pending: 0 });
  }

  dispose(): void {
    this.stop();
    this.status$.complete();
  }

  /** Scrape and ship once; aborted sessions must not update a newer session's status. */
  private async tick(signal: AbortSignal): Promise<void> {
    try {
      await this.sample(signal);
      await this.submit(signal);
      if (!signal.aborted) this.update({ lastError: null });
    } catch (error) {
      if (!signal.aborted) this.update({ lastError: error instanceof Error ? error.message : String(error) });
    }
  }

  private async sample(signal: AbortSignal): Promise<void> {
    const response = await fetch(`http://${MEDIAMTX_METRICS_ADDRESS}/metrics`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)])
    });
    if (!response.ok) throw new Error(`MediaMTX metrics returned HTTP ${response.status}`);
    const metrics = parseMediamtxMetrics(await response.text());
    signal.throwIfAborted();
    const observedAt = new Date().toISOString();
    this.pending = [...this.pending, ...metrics.map(payload => ({ observedAt, payload }))].slice(-1000);
    this.update({ lastSampledAt: observedAt });
  }

  private async submit(signal: AbortSignal): Promise<void> {
    if (this.pending.length === 0) return;
    const studio = await this.connect(signal);
    const sent = new Set(this.pending);
    const reports = Array.from(sent, ({ observedAt, payload }): Report => ({
      kind: 'metric',
      subjectId: studio.subjectId,
      observedAt,
      payload
    }));
    const result = await studio.client.reports.submit.v1({ reports });
    if (result instanceof Error) throw result;
    signal.throwIfAborted();
    this.pending = this.pending.filter(metric => !sent.has(metric));
    this.update({
      submitted: this.status$.getValue().submitted + result.accepted,
      lastSubmittedAt: new Date().toISOString()
    });
  }

  private async connect(signal: AbortSignal): Promise<Studio> {
    if (this.studio !== undefined) return this.studio;
    const config = this.config;
    if (config.type === 'direct') throw new Error('A direct agent has no studio API to report to');
    const identity = await DeviceIdentity.fromSecretKey(config.secretKey);
    const client = new Client({
      baseUrl: config.studioUrl,
      auth: deviceSignature(identity),
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) })
    });
    await client.handshake();
    const device = await client.whoami.get.v1();
    if (device instanceof Error) throw device;
    signal.throwIfAborted();
    this.studio = { client, subjectId: `device:${device.id}` };
    this.update({ subjectId: this.studio.subjectId });
    return this.studio;
  }

  private update(change: Partial<MediamtxMetricsStatus>): void {
    this.status$.next({ ...this.status$.getValue(), ...change, pending: this.pending.length });
  }
}
