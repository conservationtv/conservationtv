import type { ComponentProps, FC } from 'react';
import { cn } from '@conservationtv/ui/lib/utils';

// The parts of a delivery's card that say how to read it, composed where they're used: one row per way to read it,
// each its name, what it is for, and its buttons.
//
//   <ReadRows>
//     <ReadRow>
//       <ReadRowHeading>
//         <ReadRowTitle>RTSP</ReadRowTitle>
//         <ReadRowNote>VLC, ffmpeg and recorders</ReadRowNote>
//       </ReadRowHeading>
//       …its buttons
//     </ReadRow>
//   </ReadRows>

/** The rows, divided, inset as the card's summary is. */
export const ReadRows: FC<ComponentProps<'ul'>> = ({ className, ...props }) => {
  return <ul className={cn('divide-y divide-border px-5 pb-1.5', className)} {...props} />;
};

/** One way to read it: its ReadRowHeading, then its buttons, which wrap beneath it when the card is narrow. */
export const ReadRow: FC<ComponentProps<'li'>> = ({ className, ...props }) => {
  return <li className={cn('flex flex-wrap items-center gap-x-6 gap-y-3 py-3', className)} {...props} />;
};

export const ReadRowHeading: FC<ComponentProps<'div'>> = ({ className, ...props }) => {
  return <div className={cn('flex min-w-48 flex-1 flex-col gap-0.5', className)} {...props} />;
};

export const ReadRowTitle: FC<ComponentProps<'span'>> = ({ className, ...props }) => {
  return <span className={cn('text-custom-13 font-medium text-foreground', className)} {...props} />;
};

/** What the way to read it is for, in a line. */
export const ReadRowNote: FC<ComponentProps<'span'>> = ({ className, ...props }) => {
  return <span className={cn('text-custom-12 text-custom-text-secondary', className)} {...props} />;
};

/** A row's buttons, side by side. */
export const ReadRowActions: FC<ComponentProps<'div'>> = ({ className, ...props }) => {
  return <div className={cn('flex flex-wrap items-center gap-2', className)} {...props} />;
};
