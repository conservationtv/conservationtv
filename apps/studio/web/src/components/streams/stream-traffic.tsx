import type { FC } from 'react';

import { StreamChart } from '@/components/streams/stream-chart';
import { useStreamChart, type ChartedStream } from '@/components/streams/stream-charts';

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
  const reported = chart.rows.some(
    row => row.ingress !== undefined || row.lanEgress !== undefined || row.internetEgress !== undefined
  );
  return (
    <div className="flex flex-col gap-2">
      <StreamChart rows={chart.rows} from={chartWindow.from} to={chartWindow.to} className="h-52" />
      {!reported && (
        <p className="text-custom-12 text-muted-foreground">Nothing has reported traffic in the last three hours.</p>
      )}
    </div>
  );
};
