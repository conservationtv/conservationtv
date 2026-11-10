import type { FC } from 'react';

import { BitrateChart } from '@/components/streams/stream-chart';
import { anyReported, STREAM_LINES, useStreamChart, type ChartedStream } from '@/components/streams/stream-charts';

export interface StreamTrafficChartProps {
  stream: ChartedStream;
}

/**
 * A stream's bitrates over the chart's window, drawn larger than a card's sparkline: in from the camera, out to the
 * network and out to the internet. Says so beneath when nothing was reported in that time, as a flat line alone
 * reads like a stream sending nothing.
 */
export const StreamTrafficChart: FC<StreamTrafficChartProps> = ({ stream }) => {
  const { chart, chartWindow } = useStreamChart(stream);
  const reported = anyReported(chart.rows);
  return (
    <div className="flex flex-col gap-2">
      <BitrateChart
        lines={STREAM_LINES}
        rows={chart.rows}
        from={chartWindow.from}
        to={chartWindow.to}
        className="h-52"
      />
      {!reported && (
        <p className="text-custom-12 text-muted-foreground">Nothing has reported traffic in the last three hours.</p>
      )}
    </div>
  );
};
