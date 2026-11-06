import { startTransition, useEffect, useState } from 'react';
import { useSuspenseQueries } from '@tanstack/react-query';

import type { BitrateRow } from '@/components/streams/stream-chart';
import { useOrganisationId } from '@/hooks/use-organisation';
import {
  CHART_STEP_SECONDS,
  CHART_WINDOW_MS,
  metricPointsQueryOptions,
  metricSeriesQueryOptions,
  type MetricRange
} from '@/queries/streams';

// What a stream card charts over the window: the bitrate coming in from the camera (its first exposure's ingest), what
// its exposures send out to the network (LAN egress), what reaches the internet (what the MoQ relays received, as they
// count it). Every series is found in one round, then every series' points read in the next, so the chart arrives
// whole.

// The agent's metrics, as @conservationtv/reports names them: its MediaMTX paths' (pathMetrics), and what the relays
// carry of what it publishes (relayMetrics).
const INGEST_BITRATE = 'path.ingest.bitrate';
const LAN_EGRESS_BITRATE = 'path.egress.lan.bitrate';
const INTERNET_EGRESS_BITRATE = 'relay.ingest.bitrate';

/** The time the charts cover, in milliseconds. */
interface ChartWindow {
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

  const seriesAsks = seriesAsksOf(stream);
  const seriesQueries = useSuspenseQueries({
    queries: seriesAsks.map(ask => metricSeriesQueryOptions(organisationId, `exposure:${ask.exposureId}`, ask.metric))
  });
  const pointsAsks = seriesAsks.flatMap((ask, index) =>
    (seriesQueries[index]?.data ?? []).map(series => pointsAskOf(ask, series, range))
  );
  const pointsQueries = useSuspenseQueries({
    queries: pointsAsks.map(ask =>
      metricPointsQueryOptions(organisationId, `exposure:${ask.exposureId}`, ask.seriesId, ask.range)
    )
  });

  const answered = pointsAsks.map((ask, index) => ({ ask, points: pointsQueries[index]?.data ?? [] }));
  return { chart: chartOf(answered, chartWindow), chartWindow };
}

/**
 * The window a chart covers: ending at the latest whole bucket, moving on as each one closes. Moving on is a
 * transition, so the chart keeps showing the last window while the next one's points load, rather than suspending.
 */
function useChartWindow(): ChartWindow {
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

type Metric = typeof INGEST_BITRATE | typeof LAN_EGRESS_BITRATE | typeof INTERNET_EGRESS_BITRATE;

/** A series to look for: one metric about one of the stream's exposures. */
interface SeriesAsk {
  exposureId: string;
  metric: Metric;
}

/** Points to read: one series of one of the stream's exposures, over a range. */
interface PointsAsk {
  exposureId: string;
  seriesId: string;
  reporterId: string;
  metric: Metric;
  range: MetricRange;
}

interface ReportedSeries {
  id: string;
  reporterId: string;
}

/**
 * The ingest of the stream's first exposure, the one the camera feeds, and of every exposure what it sends to the
 * network and the internet.
 */
function seriesAsksOf(stream: ChartedStream): SeriesAsk[] {
  const root = stream.exposures.find(exposure => !exposure.upstreamExposureId);
  const ingest: SeriesAsk[] = root ? [{ exposureId: root.id, metric: INGEST_BITRATE }] : [];
  const perExposure = stream.exposures.flatMap(({ id }): SeriesAsk[] => [
    { exposureId: id, metric: LAN_EGRESS_BITRATE },
    { exposureId: id, metric: INTERNET_EGRESS_BITRATE }
  ]);
  return [...ingest, ...perExposure];
}

/** A series' points over the window. */
function pointsAskOf(ask: SeriesAsk, series: ReportedSeries, range: MetricRange): PointsAsk {
  return { exposureId: ask.exposureId, seriesId: series.id, reporterId: series.reporterId, metric: ask.metric, range };
}

interface AnsweredPoints {
  ask: PointsAsk;
  points: Point[];
}

/** The stream's chart, from the points read for it. */
function chartOf(answered: AnsweredPoints[], chartWindow: ChartWindow): StreamChartData {
  const reported = (metric: Metric) =>
    answered
      .filter(({ ask }) => ask.metric === metric)
      .map(({ ask, points }) => ({ reporterId: ask.reporterId, points }));
  const totals: BitrateTotals = {
    ingress: totalBitrate(reported(INGEST_BITRATE)),
    lanEgress: totalBitrate(reported(LAN_EGRESS_BITRATE)),
    internetEgress: totalBitrate(reported(INTERNET_EGRESS_BITRATE))
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
function totalBitrate(series: ReportedPoints[]): Map<number, number> {
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

/** Each line's bitrate, by bucket. */
interface BitrateTotals {
  ingress: Map<number, number>;
  lanEgress: Map<number, number>;
  internetEgress: Map<number, number>;
}

/** A row for every bucket in the window, so a bucket nothing was reported in breaks the line rather than bridging it. */
function bitrateRows(chartWindow: ChartWindow, totals: BitrateTotals) {
  const step = CHART_STEP_SECONDS * 1000;
  const rows: BitrateRow[] = [];
  for (let at = chartWindow.from; at < chartWindow.to; at += step) {
    rows.push({
      at,
      ingress: totals.ingress.get(at),
      lanEgress: totals.lanEgress.get(at),
      internetEgress: totals.internetEgress.get(at)
    });
  }
  return rows;
}

function toRange(from: number, to: number): MetricRange {
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}
