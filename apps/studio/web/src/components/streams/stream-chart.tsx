import type { ComponentProps, FC } from 'react';
import { z } from 'zod';
import { Area, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from 'recharts';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig
} from '@conservationtv/ui/components/chart';
import { cn } from '@conservationtv/ui/lib/utils';

/** One bucket: what came in from the camera, and what went out to the network and to the internet, in bits a second. */
export interface BitrateRow {
  at: number;
  ingress?: number;
  lanEgress?: number;
  internetEgress?: number;
}

const chartConfig = {
  ingress: { label: 'From camera', color: 'var(--chart-1)' },
  lanEgress: { label: 'To network', color: 'var(--chart-2)' },
  internetEgress: { label: 'To internet', color: 'var(--chart-3)' }
} satisfies ChartConfig;

/** Headroom above the highest point, before the scale's top is rounded up to a tidy value. */
const HEADROOM = 1.2;
/** The axes' labels, smaller than the card's text. */
const AXIS_TICK = { fontSize: 10 };

export interface StreamChartProps {
  rows: BitrateRow[];
  from: number;
  to: number;
  /** Its size, where a card's sparkline height isn't right: a stream's own page draws it taller. */
  className?: string;
}

/**
 * The stream's bitrates as a sparkline: in from the camera as a filled area behind, out
 * to the network dotted, and out to the internet dashed on top. What goes to the internet usually matches what comes
 * in, so it is drawn as a darker line riding the area's edge rather than a second line of the same kind over the first.
 */
export const StreamChart: FC<StreamChartProps> = ({ rows, from, to, className }) => {
  const highest = rows.reduce(
    (most, row) => Math.max(most, row.ingress ?? 0, row.lanEgress ?? 0, row.internetEgress ?? 0),
    0
  );
  // A flat line sits low rather than in the middle when nothing has been reported.
  const top = highest > 0 ? tidyCeiling(highest * HEADROOM) : 1e6;
  return (
    <ChartContainer config={chartConfig} className={cn('aspect-auto h-32 w-full', className)}>
      <ComposedChart data={rows} margin={{ top: 10, right: 0, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} strokeDasharray="2 4" />
        <XAxis
          dataKey="at"
          type="number"
          scale="time"
          domain={[from, to]}
          ticks={timeTicks(from, to)}
          tickFormatter={formatTick}
          tick={AXIS_TICK}
          tickLine={false}
          height={18}
        />
        <YAxis
          domain={[0, top]}
          ticks={[0, top / 2, top]}
          tickFormatter={formatBitrateTick}
          tick={AXIS_TICK}
          axisLine={false}
          tickLine={false}
          width={52}
        />
        <ChartTooltip
          cursor={{ strokeDasharray: '2 2' }}
          content={
            <ChartTooltipContent
              indicator="line"
              labelFormatter={(_, payload) => formatTime(payload[0]?.payload)}
              formatter={(value, name, item) => (
                <div className="flex w-full items-center gap-2">
                  <span
                    className="h-2.5 w-1 shrink-0 rounded-[2px]"
                    style={{ background: item.color }}
                    aria-hidden="true"
                  />
                  <span className="text-muted-foreground">{seriesLabel(name)}</span>
                  <span className="ml-auto font-mono font-medium text-foreground tabular-nums">
                    {formatBitrate(Number(value))}
                  </span>
                </div>
              )}
            />
          }
        />
        <Area
          dataKey="ingress"
          type="monotone"
          stroke="var(--color-ingress)"
          strokeWidth={1}
          fill="var(--color-ingress)"
          fillOpacity={0.12}
          dot={false}
          isAnimationActive={false}
        />
        <Line
          dataKey="lanEgress"
          type="monotone"
          stroke="var(--color-lanEgress)"
          strokeWidth={1.5}
          strokeDasharray="1 3"
          strokeLinecap="round"
          dot={false}
          isAnimationActive={false}
        />
        <Line
          dataKey="internetEgress"
          type="monotone"
          stroke="var(--color-internetEgress)"
          strokeWidth={1.75}
          strokeDasharray="5 3"
          dot={false}
          isAnimationActive={false}
        />
      </ComposedChart>
    </ChartContainer>
  );
};

/** How each line is drawn, for its key: the area filled, the others by their dashes. */
const legendDashes = {
  ingress: undefined,
  lanEgress: '1 3',
  internetEgress: '5 3'
} satisfies Record<keyof typeof chartConfig, string | undefined>;

/** What each of the chart's lines is, drawn as it is drawn in the chart, for where the chart stands without a card. */
export const StreamChartLegend: FC<ComponentProps<'ul'>> = ({ className, ...props }) => {
  return (
    <ul
      className={cn('flex flex-wrap gap-x-5 gap-y-1 text-custom-12 text-custom-text-secondary', className)}
      {...props}
    >
      {(['ingress', 'lanEgress', 'internetEgress'] satisfies (keyof typeof chartConfig)[]).map(key => (
        <li key={key} className="inline-flex items-center gap-2">
          <svg aria-hidden="true" width="18" height="8" className="overflow-visible">
            <line
              x1="0"
              y1="4"
              x2="18"
              y2="4"
              stroke={chartConfig[key].color}
              strokeWidth={key === 'ingress' ? 6 : 1.75}
              strokeOpacity={key === 'ingress' ? 0.3 : 1}
              strokeDasharray={legendDashes[key]}
              strokeLinecap={key === 'lanEgress' ? 'round' : undefined}
            />
          </svg>
          {chartConfig[key].label}
        </li>
      ))}
    </ul>
  );
};

/** A line's label in the tooltip, by the `dataKey` Recharts names it with. */
function seriesLabel(name: string | number | undefined): string {
  if (name === 'lanEgress') return chartConfig.lanEgress.label;
  if (name === 'internetEgress') return chartConfig.internetEgress.label;
  return chartConfig.ingress.label;
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

/** Every whole hour in the window, or every half hour when that would leave fewer than three. */
function timeTicks(from: number, to: number): number[] {
  const hour = 60 * 60 * 1000;
  const step = to - from < 3 * hour ? hour / 2 : hour;
  const ticks: number[] = [];
  for (let at = Math.ceil(from / step) * step; at <= to; at += step) ticks.push(at);
  return ticks;
}

function formatTick(at: number): string {
  return timeFormat.format(at);
}

/** The smallest of 1, 2, 2.5 or 5 times a power of ten at or above `value`, so the scale's labels read cleanly. */
function tidyCeiling(value: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const tidy = [1, 2, 2.5, 5, 10].find(step => step * magnitude >= value) ?? 10;
  return tidy * magnitude;
}

/** A scale label: bits a second in the largest unit that keeps it whole or a single decimal. */
function formatBitrateTick(bits: number): string {
  if (bits === 0) return '0';
  if (bits >= 1e6) return `${Number((bits / 1e6).toFixed(1))} Mb/s`;
  if (bits >= 1e3) return `${Math.round(bits / 1e3)} kb/s`;
  return `${Math.round(bits)} b/s`;
}

/** The row under the tooltip, as Recharts hands it back untyped. */
const HoveredRowSchema = z.object({ at: z.number() });
type HoveredRow = z.output<typeof HoveredRowSchema>;

function formatTime(row: HoveredRow | undefined): string {
  const parsed = HoveredRowSchema.safeParse(row);
  return parsed.success ? timeFormat.format(parsed.data.at) : '';
}

/** Bits per second, in the largest unit that keeps it above one. */
function formatBitrate(bits: number): string {
  if (bits >= 1e6) return `${(bits / 1e6).toFixed(1)} Mb/s`;
  if (bits >= 1e3) return `${Math.round(bits / 1e3)} kb/s`;
  return `${Math.round(bits)} b/s`;
}
