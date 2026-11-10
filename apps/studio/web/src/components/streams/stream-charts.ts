import { startTransition, useEffect, useState } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';

import { useOrganisationId } from '@/hooks/use-organisation';
import { CHART_STEP_SECONDS, CHART_WINDOW_MS, metricQueryQueryOptions, type MetricRange } from '@/queries/streams';

// What a stream card charts over the window: the bitrate coming in from the camera (its first exposure's ingest), what
// its exposures send out to the network (LAN egress), what reaches the internet (what the MoQ relays received, as they
// count it). One read across the stream's exposures returns every series with its points, so the chart arrives whole.

// The agent's metrics, as @conservationtv/reports names them: its MediaMTX paths' (pathMetrics), and what the relays
// carry of what it publishes (relayMetrics).
const INGEST_BITRATE = 'path.ingest.bitrate';
const LAN_EGRESS_BITRATE = 'path.egress.lan.bitrate';
const INTERNET_EGRESS_BITRATE = 'relay.ingest.bitrate';

/** One bucket: its time, and each line's value in it, in bits a second, by the line's key. Undefined where none. */
export interface BitrateRow extends Partial<Record<string, number>> {
  at: number;
}

/** How a line is drawn: filled beneath (what comes in), dotted, or dashed on top. */
export type BitrateLineStyle = 'area' | 'dotted' | 'dashed';

/** One of a chart's lines: its key in the rows (a CSS identifier: it names a colour variable), name, colour and look. */
export interface BitrateLine {
  key: string;
  label: string;
  colour: string;
  style: BitrateLineStyle;
}

/**
 * A stream's lines: in from the camera as a filled area behind, out to the network dotted, and out to the internet
 * dashed on top. What goes to the internet usually matches what comes in, so it is drawn as a darker line riding the
 * area's edge rather than a second line of the same kind over the first.
 */
export const STREAM_LINES: BitrateLine[] = [
  { key: 'ingress', label: 'From camera', colour: 'var(--chart-1)', style: 'area' },
  { key: 'lanEgress', label: 'To network', colour: 'var(--chart-2)', style: 'dotted' },
  { key: 'internetEgress', label: 'To internet', colour: 'var(--chart-3)', style: 'dashed' }
];

/** The time the charts cover, in milliseconds. */
export interface ChartWindow {
  from: number;
  to: number;
}

/** One stream's chart. */
interface StreamChartData {
  rows: BitrateRow[];
}

interface ExposureLink {
  id: string;
  upstreamExposureId: string | null;
}

/** A stream as its chart needs it: which exposures deliver it. */
export interface ChartedStream {
  id: string;
  exposures: ExposureLink[];
}

/** A stream's chart, over a window that moves on as time passes. */
export function useStreamChart(stream: ChartedStream) {
  const organisationId = useOrganisationId();
  const chartWindow = useChartWindow();
  const range = toRange(chartWindow.from, chartWindow.to);

  const subjectIds = stream.exposures.map(({ id }) => `exposure:${id}`);
  const { data: series } = useSuspenseQuery(metricQueryQueryOptions(organisationId, subjectIds, METRICS, range));
  return { chart: chartOf(stream, series, chartWindow), chartWindow };
}

/**
 * The window a chart covers: ending at the latest whole bucket, moving on as each one closes. Moving on is a
 * transition, so the chart keeps showing the last window while the next one's points load, rather than suspending.
 */
export function useChartWindow(): ChartWindow {
  const [to, setTo] = useState(latestBucket);
  useEffect(() => {
    const timer = setInterval(() => startTransition(() => setTo(latestBucket())), 30_000);
    return () => clearInterval(timer);
  }, []);
  return { from: to - CHART_WINDOW_MS, to };
}

function latestBucket(): number {
  const step = CHART_STEP_SECONDS * 1000;
  return Math.floor(Date.now() / step) * step;
}

const METRICS = [INGEST_BITRATE, LAN_EGRESS_BITRATE, INTERNET_EGRESS_BITRATE];

/** A series as a chart reads it: what it measures, about which subject, who reported it, and its points. */
export interface ReportedSeries {
  subjectId: string;
  name: string;
  reporterId: string;
  points: Point[];
}

/**
 * The stream's chart, from its series: the ingest of its first exposure, the one the camera feeds, and of every
 * exposure what it sends to the network and the internet.
 */
function chartOf(stream: ChartedStream, series: ReportedSeries[], chartWindow: ChartWindow): StreamChartData {
  const root = stream.exposures.find(exposure => !exposure.upstreamExposureId);
  const ingest = series.filter(
    ({ name, subjectId }) => name === INGEST_BITRATE && subjectId === `exposure:${root?.id}`
  );
  const totals = {
    ingress: totalBitrate(ingest),
    lanEgress: totalBitrate(series.filter(({ name }) => name === LAN_EGRESS_BITRATE)),
    internetEgress: totalBitrate(series.filter(({ name }) => name === INTERNET_EGRESS_BITRATE))
  };
  return { rows: bitrateRows(chartWindow, totals) };
}

interface Point {
  at: string;
  avg: number;
}

/** A series' points, with who reported them. */
interface ReportedPoints {
  reporterId: string;
  points: Point[];
}

/**
 * The bitrate in each bucket: each reporter's paths (every rendition of every exposure it serves) add up, as they are
 * separate, but two reporters measure the same thing, so the larger stands rather than their sum.
 */
export function totalBitrate(series: ReportedPoints[]): Map<number, number> {
  const byReporter = new Map<string, Map<number, number>>();
  for (const { reporterId, points } of series) {
    const sums = byReporter.get(reporterId) ?? new Map<number, number>();
    for (const point of points) {
      const at = Date.parse(point.at);
      sums.set(at, (sums.get(at) ?? 0) + point.avg);
    }
    byReporter.set(reporterId, sums);
  }
  const totals = new Map<number, number>();
  for (const sums of byReporter.values()) {
    for (const [at, bits] of sums) totals.set(at, Math.max(totals.get(at) ?? 0, bits));
  }
  return totals;
}

/** Each line's bitrate, by bucket, by the line's key. */
export type BitrateTotals = Record<string, Map<number, number>>;

/**
 * A row for every bucket in the window, each line's value in it by its key, so a bucket nothing was reported in breaks
 * the line rather than bridging it.
 */
export function bitrateRows(chartWindow: ChartWindow, totals: BitrateTotals): BitrateRow[] {
  const step = CHART_STEP_SECONDS * 1000;
  const rows: BitrateRow[] = [];
  for (let at = chartWindow.from; at < chartWindow.to; at += step) {
    const values = Object.fromEntries(Object.entries(totals).map(([key, total]) => [key, total.get(at)]));
    rows.push({ ...values, at });
  }
  return rows;
}

/** Whether anything was reported for any line in the window: a flat line alone reads like nothing being sent. */
export function anyReported(rows: BitrateRow[]): boolean {
  return rows.some(row => Object.entries(row).some(([key, value]) => key !== 'at' && value !== undefined));
}

export function toRange(from: number, to: number): MetricRange {
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}
