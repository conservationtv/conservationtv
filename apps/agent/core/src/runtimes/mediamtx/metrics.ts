import type { Metric } from '../../reporting.ts';

// MediaMTX's metrics, read from its Prometheus endpoint and turned into the studio API's metrics. MediaMTX writes no
// `# TYPE` lines, so whether each is a gauge or a counter is decided here, by its name:
//
// - A count of things (`paths`, `rtsp_sessions`, `hls_muxers`, …): a gauge. With entities, one line per entity with
//   the value 1, its labels saying which; with none, one unlabelled 0.
// - A rate, a buffer, a round trip, jitter or a size: a gauge.
// - Everything else (bytes, packets and frames, sent, received, lost or dropped): a counter, from when the entity
//   appeared.
//
// Metrics MediaMTX marks deprecated duplicate their replacements, so they're left out, as is the deprecated
// `remoteAddr` label.

/** Metrics MediaMTX v1.21 still writes, beside the ones replacing them. */
const DEPRECATED =
  /^(paths_(bytes_(received|sent)|readers)|hls_muxers_bytes_sent|(rtsps?|rtmps?)_conns_bytes_(received|sent)|(rtsps?|webrtc)_sessions_(bytes_(received|sent)|rtc?p_packets_(received|sent|lost|in_error|jitter)))$/;
const DEPRECATED_LABELS = new Set(['remoteAddr']);

const COUNT = /^(paths|[a-z]+_(conns|sessions|muxers))$/;
const GAUGE =
  /(_jitter|_rate|_buf|_mss|_flow_window|_flight_size|_tsb_pd_delay|_reorder_tolerance|_avg_belated_time|_send_period)$|_(ms|mbps|avail)_/;

/** Units, by the first word of the name that names one. */
const UNITS = new Map([
  ['bytes', 'bytes'],
  ['packets', 'packets'],
  ['frames', 'frames'],
  ['ms', 'milliseconds'],
  ['us', 'microseconds'],
  ['mbps', 'megabits per second']
]);

type Dimensions = NonNullable<Metric['dimensions']>;

/** The studio API's limits on a dimension. */
const MAX_DIMENSION_KEY = 60;
const MAX_DIMENSION_VALUE = 200;

/** `name{labels} value [timestamp]` */
const SAMPLE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)(?:\s+-?\d+)?$/;
const LABEL = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

/** Reads MediaMTX's metrics from `address`. Throws if it doesn't answer. */
export async function scrape(address: string, signal: AbortSignal): Promise<Metric[]> {
  const response = await fetch(`http://${address}/metrics`, { signal });
  if (!response.ok) throw new Error(`MediaMTX's metrics answered ${response.status}`);
  return parseMetrics(await response.text());
}

/** MediaMTX's Prometheus text as the studio API's metrics, named `mediamtx.<name>`. */
export function parseMetrics(text: string): Metric[] {
  return text.split('\n').flatMap(line => {
    const metric = metricOf(line);
    return metric === undefined ? [] : [metric];
  });
}

/**
 * One line as a metric. Comments and blank lines don't match a sample, and deprecated metrics and values that aren't
 * finite numbers (`NaN`, `+Inf`) are left out: the studio API takes neither.
 */
function metricOf(line: string): Metric | undefined {
  const match = SAMPLE.exec(line.trim());
  if (match === null) return undefined;
  const [, name, labels = '', text] = match;
  if (name === undefined || text === undefined || DEPRECATED.test(name)) return undefined;
  const value = Number(text);
  if (!Number.isFinite(value)) return undefined;
  return {
    name: `mediamtx.${name}`,
    type: COUNT.test(name) || GAUGE.test(name) ? 'gauge' : 'counter',
    value,
    unit: unitOf(name),
    dimensions: dimensionsOf(labels)
  };
}

function unitOf(name: string): string | null {
  const words = name.split('_');
  const word = words.find(each => UNITS.has(each));
  return word === undefined ? null : (UNITS.get(word) ?? null);
}

/**
 * The labels as dimensions, unescaped. Deprecated labels and keys too long for the studio API are left out, and values
 * too long are cut to fit.
 */
function dimensionsOf(labels: string): Dimensions {
  const dimensions: Dimensions = {};
  for (const [, key, escaped] of labels.matchAll(LABEL)) {
    // Each `key="value"`, with `\"`, `\\` and `\n` escaped inside the value.
    if (key === undefined || escaped === undefined) continue;
    if (DEPRECATED_LABELS.has(key) || key.length > MAX_DIMENSION_KEY) continue;
    const value = escaped.replace(/\\(.)/g, (_, character: string) => (character === 'n' ? '\n' : character));
    dimensions[key] = value.slice(0, MAX_DIMENSION_VALUE);
  }
  return dimensions;
}
