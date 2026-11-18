import { type PrometheusSample, parseMetrics } from '@conservationtv/mediamtx';

// Reading a MediaMTX's metrics page, whichever MediaMTX it is: the gateway's, for the `metrics` key
// (gateway/metrics/runtime.ts), and the program MediaMTX's, for the program's reports (output/obs/program-metrics.ts).
// A read is each path's counters, each of the agent's MoQ publishers' connections, each forward destination, and the
// paths something publishes to over RTMP; the rates between two reads are worked out here too.

const SCRAPE_TIMEOUT_MS = 5_000;

/** What one read of the metrics page says of a path. Byte and error counts are MediaMTX's running totals. */
export interface PathReading {
  ready: number;
  readers: number;
  inboundBytes: number;
  outboundBytes: number;
  framesInError: number;
}

/** One of the agent's MoQ publishers reading a path: the path, and the bytes sent it so far on this connection. */
export interface PublisherReading {
  path: string;
  outboundBytes: number;
}

/**
 * One of a path's forward destinations (its config's `forward`): the path, its place in that list (from 1), MediaMTX's
 * state for it (`idle`, `forwarding` or `error`), and the bytes sent it so far.
 */
export interface ForwardReading {
  path: string;
  pos: number;
  state: string;
  outboundBytes: number;
}

/**
 * A read of the metrics page, at a time: each path's reading, each publisher connection's and each forward
 * destination's, by its ID, and the paths something publishes to over RTMP.
 */
export interface Read {
  at: number;
  paths: Map<string, PathReading>;
  publishers: Map<string, PublisherReading>;
  forwards: Map<string, ForwardReading>;
  rtmpPublished: Set<string>;
}

/** The per-path samples a reading is made from, by the field each adds to. */
const PATH_FIELDS = new Map<string, keyof PathReading>([
  ['paths', 'ready'],
  ['paths_readers', 'readers'],
  ['paths_inbound_bytes', 'inboundBytes'],
  ['paths_outbound_bytes', 'outboundBytes'],
  ['paths_inbound_frames_in_error', 'framesInError']
]);

/** Each path's reading, adding up the samples MediaMTX gives it per label, such as one per reader type. */
export function readingsOf(samples: PrometheusSample[]): Map<string, PathReading> {
  const paths = new Map<string, PathReading>();
  for (const sample of samples) {
    // A per-path sample adds to its path's reading, under the field its name gives. MediaMTX gives `paths` under the
    // path's state, so only a ready path's counts as ready, but every path gets a reading.
    const path = sample.labels.name;
    const field = PATH_FIELDS.get(sample.name);
    if (sample.deprecated || path === undefined || field === undefined) continue;
    const reading = paths.get(path) ?? { ready: 0, readers: 0, inboundBytes: 0, outboundBytes: 0, framesInError: 0 };
    paths.set(path, reading);
    if (field !== 'ready' || sample.labels.state === 'ready') reading[field] += sample.value;
  }
  return paths;
}

/**
 * Whether a reading RTMP connection is one of the agent's MoQ publishers rather than a reader on the network. The
 * publishers are the only RTMP readers on MediaMTX's own machine (gateway/streams/builders/publishers.ts), so for now that is told by
 * the connection coming from loopback. This is the one place that says so: telling them apart some other way only
 * changes this.
 */
function isAgentPublisher(remoteAddr: string | undefined): boolean {
  return remoteAddr !== undefined && (remoteAddr.startsWith('127.') || remoteAddr.startsWith('[::1]'));
}

/** Each of the agent's MoQ publishers' connections (`isAgentPublisher`), by connection ID. */
function publishersOf(samples: PrometheusSample[]): Map<string, PublisherReading> {
  const publishers = new Map<string, PublisherReading>();
  for (const sample of samples) {
    // A reading RTMP connection that is one of the agent's publishers counts as publisher egress; every other
    // connection is a reader on the network, counted with the path's total.
    const { id, path, remoteAddr, state } = sample.labels;
    if (sample.deprecated || sample.name !== 'rtmp_conns_outbound_bytes' || state !== 'read') continue;
    if (id === undefined || path === undefined || !isAgentPublisher(remoteAddr)) continue;
    publishers.set(id, { path, outboundBytes: sample.value });
  }
  return publishers;
}

/** Each forward destination, by its ID, which MediaMTX gives it anew whenever it starts forwarding afresh. */
function forwardsOf(samples: PrometheusSample[]): Map<string, ForwardReading> {
  const forwards = new Map<string, ForwardReading>();
  for (const sample of samples) {
    // Each destination's byte count, labelled with its path, its place in the path's list, and its state; anything
    // else, or one missing a label, is skipped.
    const { id, path, pos, state } = sample.labels;
    if (sample.deprecated || sample.name !== 'forward_dests_outbound_bytes') continue;
    if (id === undefined || path === undefined || pos === undefined) continue;
    forwards.set(id, { path, pos: Number(pos), state: state ?? '', outboundBytes: sample.value });
  }
  return forwards;
}

/** The paths an RTMP connection publishes to: OBS's stream to the program, say. */
function rtmpPublishedOf(samples: PrometheusSample[]): Set<string> {
  const published = new Set<string>();
  for (const sample of samples) {
    // Each RTMP connection publishing to a path; reading ones, and deprecated duplicates, are skipped.
    const { path, state } = sample.labels;
    if (sample.deprecated || sample.name !== 'rtmp_conns' || state !== 'publish' || path === undefined) continue;
    published.add(path);
  }
  return published;
}

/** A read of the metrics page, and how many samples it had. */
export interface MetricsPage {
  read: Read;
  samples: number;
}

/** Reads MediaMTX's metrics page at `url`, as of now. Throws if it doesn't answer, or answers with an error. */
export async function readMetricsPage(url: string): Promise<MetricsPage> {
  const response = await fetch(url, { signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`MediaMTX's metrics page answered ${response.status}`);
  const text = await response.text();
  const samples = parseMetrics(text);
  const read: Read = {
    at: Date.now(),
    paths: readingsOf(samples),
    publishers: publishersOf(samples),
    forwards: forwardsOf(samples),
    rtmpPublished: rtmpPublishedOf(samples)
  };
  return { read, samples: samples.length };
}

/**
 * How many bits a second each forward destination was sent between two reads, by its ID. One the previous read did not
 * have counts from zero, as one started since; one whose count went back was reset, and gives no rate.
 */
export function forwardRates(read: Read, previous: Read, seconds: number): Map<string, number> {
  const rates = new Map<string, number>();
  for (const [id, reading] of read.forwards) {
    const before = previous.forwards.get(id)?.outboundBytes ?? 0;
    const moved = reading.outboundBytes - before;
    if (moved >= 0) rates.set(id, (moved * 8) / seconds);
  }
  return rates;
}

/**
 * How many bits a second each path sent its publishers between two reads. A connection counts from zero when the
 * previous read did not have it, as one opened since; one whose count went back was reset, and gives no rate.
 */
export function publisherRates(read: Read, previous: Read, seconds: number): Map<string, number> {
  const rates = new Map<string, number>();
  for (const [id, reading] of read.publishers) {
    // Each connection adds what it moved to its path's rate: from zero if it is new, nothing if its count went back.
    const before = previous.publishers.get(id)?.outboundBytes ?? 0;
    const moved = reading.outboundBytes - before;
    if (moved < 0) continue;
    rates.set(reading.path, (rates.get(reading.path) ?? 0) + (moved * 8) / seconds);
  }
  return rates;
}
