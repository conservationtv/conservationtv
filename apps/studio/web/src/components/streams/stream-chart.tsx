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

import type { BitrateLine, BitrateLineStyle, BitrateRow } from '@/components/streams/stream-charts';

/** Headroom above the highest point, before the scale's top is rounded up to a tidy value. */
const HEADROOM = 1.2;
/** The axes' labels, smaller than the card's text. */
const AXIS_TICK = { fontSize: 10 };

/** How each style is stroked: its dashes, width and ends. */
const lineStrokes = {
  area: { strokeDasharray: undefined, strokeWidth: 1, strokeLinecap: undefined },
  dotted: { strokeDasharray: '1 3', strokeWidth: 1.5, strokeLinecap: 'round' },
  dashed: { strokeDasharray: '5 3', strokeWidth: 1.75, strokeLinecap: undefined }
} as const satisfies Record<BitrateLineStyle, LineStroke>;

/** How a line's stroke is drawn. */
interface LineStroke {
  strokeDasharray: string | undefined;
  strokeWidth: number;
  strokeLinecap: 'round' | undefined;
}

export interface BitrateChartProps {
  lines: BitrateLine[];
  rows: BitrateRow[];
  from: number;
  to: number;
  /** Its size, where a card's sparkline height isn't right: a stream's own page draws it taller. */
  className?: string;
}

/** Bitrates over time as a sparkline: each line drawn in its style, over a scale that fits the highest point. */
export const BitrateChart: FC<BitrateChartProps> = ({ lines, rows, from, to, className }) => {
  const highest = rows.reduce((most, row) => Math.max(most, ...lines.map(line => row[line.key] ?? 0)), 0);
  // A flat line sits low rather than in the middle when nothing has been reported.
  const top = highest > 0 ? tidyCeiling(highest * HEADROOM) : 1e6;
  const config: ChartConfig = Object.fromEntries(
    lines.map(line => [line.key, { label: line.label, color: line.colour }])
  );
  return (
    <ChartContainer config={config} className={cn('aspect-auto h-32 w-full', className)}>
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
                  <span className="text-muted-foreground">{lineLabel(lines, name)}</span>
                  <span className="ml-auto font-mono font-medium text-foreground tabular-nums">
                    {formatBitrate(Number(value))}
                  </span>
                </div>
              )}
            />
          }
        />
        {lines.map(line =>
          line.style === 'area' ? (
            <Area
              key={line.key}
              dataKey={line.key}
              type="monotone"
              stroke={`var(--color-${line.key})`}
              strokeWidth={lineStrokes.area.strokeWidth}
              fill={`var(--color-${line.key})`}
              fillOpacity={0.12}
              dot={false}
              isAnimationActive={false}
            />
          ) : (
            <Line
              key={line.key}
              dataKey={line.key}
              type="monotone"
              stroke={`var(--color-${line.key})`}
              {...lineStrokes[line.style]}
              dot={false}
              isAnimationActive={false}
            />
          )
        )}
      </ComposedChart>
    </ChartContainer>
  );
};

export interface BitrateChartLegendProps extends ComponentProps<'ul'> {
  lines: BitrateLine[];
}

/** What each of a chart's lines is, drawn as it is drawn in the chart, for where the chart stands without a card. */
export const BitrateChartLegend: FC<BitrateChartLegendProps> = ({ lines, className, ...props }) => {
  return (
    <ul
      className={cn('flex flex-wrap gap-x-5 gap-y-1 text-custom-12 text-custom-text-secondary', className)}
      {...props}
    >
      {lines.map(line => (
        <li key={line.key} className="inline-flex items-center gap-2">
          <svg aria-hidden="true" width="18" height="8" className="overflow-visible">
            <line
              x1="0"
              y1="4"
              x2="18"
              y2="4"
              stroke={line.colour}
              strokeWidth={line.style === 'area' ? 6 : lineStrokes[line.style].strokeWidth}
              strokeOpacity={line.style === 'area' ? 0.3 : 1}
              strokeDasharray={lineStrokes[line.style].strokeDasharray}
              strokeLinecap={lineStrokes[line.style].strokeLinecap}
            />
          </svg>
          {line.label}
        </li>
      ))}
    </ul>
  );
};

/** A line's label in the tooltip, by the `dataKey` Recharts names it with. */
function lineLabel(lines: BitrateLine[], name: string | number | undefined): string {
  return lines.find(line => line.key === name)?.label ?? '';
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
