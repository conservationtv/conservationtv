import type { ComponentProps, FC } from 'react';
import { GRID_UNITS, type SlotRect } from '@conservationtv/shows';
import { cn } from '@conservationtv/ui/lib/utils';

// A show's layout drawn from the one table the broadcast is composed from (packages/shows/src/layouts.ts): the canvas
// as a 6×6 grid, each position a rectangle on it. The layout picker and the controls' map of what is on screen are both
// drawn with these parts, so neither can disagree with what goes out.

/** The canvas, 16:9, as the layout's grid: place a `LayoutCell` on it for each position. */
export const LayoutGrid: FC<ComponentProps<'div'>> = ({ className, style, ...props }) => {
  return (
    <div
      className={cn('grid aspect-video w-full', className)}
      style={{
        gridTemplateColumns: `repeat(${String(GRID_UNITS)}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${String(GRID_UNITS)}, minmax(0, 1fr))`,
        ...style
      }}
      {...props}
    />
  );
};

export interface LayoutCellProps extends ComponentProps<'div'> {
  /** The position's rectangle on the grid, from the layout table. */
  rect: SlotRect;
}

/** One position of a layout, placed on its `LayoutGrid` where the table puts it. */
export const LayoutCell: FC<LayoutCellProps> = ({ rect, style, ...props }) => {
  const [column, row, width, height] = rect;
  return (
    <div
      style={{
        gridColumn: `${String(column + 1)} / span ${String(width)}`,
        gridRow: `${String(row + 1)} / span ${String(height)}`,
        ...style
      }}
      {...props}
    />
  );
};
