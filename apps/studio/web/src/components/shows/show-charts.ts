import { useSuspenseQuery } from '@tanstack/react-query';
import type { Show } from '@conservationtv/studio-sdk';

import { forwardSubjectId, previewSubjectId, programSubjectId } from '@/components/devices/subjects';
import {
  bitrateRows,
  type BitrateLine,
  type BitrateRow,
  toRange,
  totalBitrate,
  useChartWindow,
  type ChartWindow,
  type ReportedSeries
} from '@/components/streams/stream-charts';
import { useOrganisationId } from '@/hooks/use-organisation';
import { metricQueryQueryOptions } from '@/queries/streams';

// What a show's traffic chart draws over the window, as a stream's does: what OBS sends into the programme (the
// program MediaMTX's ingest), what goes out to its channels (every forward's egress, added up) and what goes out to
// its previews. Then each forward and preview on its own line. One read across the show's subjects returns every
// series, so the charts arrive together.

// The output agent's metrics, as @conservationtv/reports names them (programMetrics, forwardMetrics, previewMetrics).
const PROGRAM_INGEST_BITRATE = 'program.ingest.bitrate';
const FORWARD_EGRESS_BITRATE = 'forward.egress.bitrate';
const PREVIEW_EGRESS_BITRATE = 'preview.egress.bitrate';
const METRICS = [PROGRAM_INGEST_BITRATE, FORWARD_EGRESS_BITRATE, PREVIEW_EGRESS_BITRATE];

/**
 * A show's lines: the programme as a filled area behind, what goes to its channels dashed on top (it usually rides
 * the area's edge, as a stream's internet line does), and what goes to its previews dotted.
 */
export const SHOW_LINES: BitrateLine[] = [
  { key: 'programme', label: 'Programme', colour: 'var(--chart-1)', style: 'area' },
  { key: 'channels', label: 'To channels', colour: 'var(--chart-3)', style: 'dashed' },
  { key: 'previews', label: 'To previews', colour: 'var(--chart-2)', style: 'dotted' }
];

/** One forward's or preview's line: what it is sent. */
export const PART_LINES: BitrateLine[] = [{ key: 'sent', label: 'Sent', colour: 'var(--chart-3)', style: 'area' }];

/** A show's charts: the whole show's, and each forward's and preview's by its ID, over one window. */
export interface ShowChart {
  chartWindow: ChartWindow;
  rows: BitrateRow[];
  parts: Map<string, BitrateRow[]>;
}

/** A show's charts, over a window that moves on as time passes. */
export function useShowChart(show: Show): ShowChart {
  const organisationId = useOrganisationId();
  const chartWindow = useChartWindow();
  const range = toRange(chartWindow.from, chartWindow.to);
  const subjectIds = [
    programSubjectId(show.id),
    ...show.forwards.map(forward => forwardSubjectId(forward.id)),
    ...show.previews.map(preview => previewSubjectId(preview.id))
  ];
  const { data: series } = useSuspenseQuery(metricQueryQueryOptions(organisationId, subjectIds, METRICS, range));
  return {
    chartWindow,
    rows: bitrateRows(chartWindow, {
      programme: totalBitrate(series.filter(({ name }) => name === PROGRAM_INGEST_BITRATE)),
      channels: totalBitrate(series.filter(({ name }) => name === FORWARD_EGRESS_BITRATE)),
      previews: totalBitrate(series.filter(({ name }) => name === PREVIEW_EGRESS_BITRATE))
    }),
    parts: new Map([
      ...show.forwards.map(forward => partChart(forward.id, forwardSubjectId(forward.id), series, chartWindow)),
      ...show.previews.map(preview => partChart(preview.id, previewSubjectId(preview.id), series, chartWindow))
    ])
  };
}

/** One forward's or preview's line, by its ID: what its subject's series say it was sent. */
function partChart(
  id: string,
  subjectId: string,
  series: ReportedSeries[],
  chartWindow: ChartWindow
): [string, BitrateRow[]] {
  const sent = totalBitrate(series.filter(candidate => candidate.subjectId === subjectId));
  return [id, bitrateRows(chartWindow, { sent })];
}
