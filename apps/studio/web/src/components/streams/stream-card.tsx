import type { ComponentProps, FC } from 'react';
import { cn } from '@conservationtv/ui/lib/utils';

import { StreamChart } from '@/components/streams/stream-chart';
import { useStreamChart, type ChartedStream } from '@/components/streams/stream-charts';

// A stream card's parts, composed where they're used: the grid, the card, its title, a note and its chart.

/** The cards, as many to a row as fit. */
export const StreamGrid: FC<ComponentProps<'div'>> = ({ className, ...props }) => {
  return (
    <div
      className={cn('grid grid-cols-[repeat(auto-fill,minmax(min(100%,28rem),1fr))] gap-x-14 gap-y-16', className)}
      {...props}
    />
  );
};

export const StreamCard: FC<ComponentProps<'article'>> = ({ className, ...props }) => {
  return <article className={cn('flex min-w-0 flex-col gap-5', className)} {...props} />;
};

export const StreamCardTitle: FC<ComponentProps<'h2'>> = ({ className, ...props }) => {
  return <h2 className={cn('text-custom-17 font-medium text-foreground', className)} {...props} />;
};

/** A line under the title for what the card can't show yet. */
export const StreamCardNote: FC<ComponentProps<'p'>> = ({ className, ...props }) => {
  return <p className={cn('text-custom-13 text-muted-foreground', className)} {...props} />;
};

export interface StreamCardChartProps {
  stream: ChartedStream;
}

/** The stream's bitrates, once all of them have loaded. */
export const StreamCardChart: FC<StreamCardChartProps> = ({ stream }) => {
  const { chart, chartWindow } = useStreamChart(stream);
  return <StreamChart rows={chart.rows} from={chartWindow.from} to={chartWindow.to} />;
};
