import type { Metric } from '../reporter.ts';

// MediaMTX's Prometheus metrics, as the studio API takes them: `mediamtx.<name>`, with each metric's labels as its
// dimensions.

/** One sample in Prometheus' text format: `name{label="value",…} value [timestamp]`. */
const SAMPLE = /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})?\s+(\S+)(?:\s+-?\d+)?$/;
const LABEL = /(\w+)="((?:[^"\\]|\\.)*)"/g;
// MediaMTX gives no `# TYPE` lines or units, so both come from the name. Counts of bytes, packets and frames are
// totals, apart from levels (buffers, windows) and what is derived from them (rates, times, jitter).
const UNIT = /(?:^|_)(bytes|packets|frames|mbps|ms|us)(?:_|$)/;
const COUNTED = new Set(['bytes', 'packets', 'frames']);
const LEVEL = /_(buf|size|window|mss|tolerance|period)$/;
const DERIVED = /_(rate|time|jitter)$/;

/** A sample's labels, unescaped. */
function dimensionsOf(labels: string) {
  const unescape = (quoted: string) =>
    quoted.replace(/\\(.)/g, (_escape, char: string) => (char === 'n' ? '\n' : char));
  return Object.fromEntries(Array.from(labels.matchAll(LABEL), ([, key, quoted]) => [key!, unescape(quoted!)]));
}

/** A metric's type and unit, from its name: the first unit named, unless the value is a rate or time derived from it. */
function kindOf(name: string): Pick<Metric, 'type' | 'unit'> {
  const unit = DERIVED.test(name) ? null : (UNIT.exec(name)?.[1] ?? null);
  const counter = unit !== null && COUNTED.has(unit) && !LEVEL.test(name);
  return { type: counter ? 'counter' : 'gauge', unit };
}

/** One sample line as a metric, or `undefined` if it isn't one. */
function metricOf(line: string): Metric | undefined {
  const match = SAMPLE.exec(line);
  const value = Number(match?.[3]);
  if (match === null || !Number.isFinite(value)) return undefined;
  const name = match[1]!;
  const dimensions = dimensionsOf(match[2] ?? '');
  return { name: `mediamtx.${name}`, ...kindOf(name), value, dimensions };
}

/**
 * MediaMTX's metrics, as the studio API takes them. MediaMTX repeats some under older names, in sections it heads
 * "(deprecated)"; those are left out.
 */
export function parseMetrics(text: string): Metric[] {
  const metrics: Metric[] = [];
  let deprecated = false;
  for (const raw of text.split('\n')) {
    // Sections are separated by blank lines, and headed by comments: a deprecated one is skipped up to the next blank.
    const line = raw.trim();
    if (line === '') deprecated = false;
    else if (line.startsWith('#')) deprecated ||= line.includes('(deprecated)');
    else if (!deprecated) {
      const metric = metricOf(line);
      if (metric !== undefined) metrics.push(metric);
    }
  }
  return metrics;
}

/** MediaMTX's metrics endpoint. */
export class MediamtxMetrics {
  /** `address` is where MediaMTX serves its metrics, such as `127.0.0.1:9998`. */
  constructor(private readonly address: string) {}

  /** Whether MediaMTX is serving its metrics: the sign it is up. */
  alive(): Promise<boolean> {
    return this.text().then(
      () => true,
      () => false
    );
  }

  /** The metrics as they are now. */
  async scrape(): Promise<Metric[]> {
    return parseMetrics(await this.text());
  }

  private async text(): Promise<string> {
    const response = await fetch(`http://${this.address}/metrics`, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) throw new Error(`MediaMTX's metrics answered ${response.status}`);
    return response.text();
  }
}
