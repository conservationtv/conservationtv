import type { ComponentProps, FC } from 'react';
import type { Rendition } from '@conservationtv/studio-sdk';
import { Tabs, TabsList, TabsTrigger } from '@conservationtv/ui/components/tabs';
import { cn } from '@conservationtv/ui/lib/utils';

import { renditionLabels } from '@/components/streams/renditions';

// The parts of a delivery's card that say how to read it, composed where they're used: the renditions it offers as
// compact tabs across the card, then one row per way to read it, each its name, what it is for, and its buttons.
//
//   <RenditionTabs renditions={offered} value={selected} onValueChange={choose} />
//   <ReadRows>
//     <ReadRow>
//       <ReadRowHeading>
//         <ReadRowTitle>RTSP</ReadRowTitle>
//         <ReadRowNote>VLC, ffmpeg and recorders</ReadRowNote>
//       </ReadRowHeading>
//       …its buttons
//     </ReadRow>
//   </ReadRows>

export interface RenditionTabsProps {
  /** The renditions offered, in the order they are shown. */
  renditions: Rendition[];
  value: Rendition;
  onValueChange: (rendition: Rendition) => void;
}

/** The renditions as compact line tabs across the card, its rule beneath them running to the card's edges. */
export const RenditionTabs: FC<RenditionTabsProps> = ({ renditions, value, onValueChange }) => {
  return (
    <Tabs
      value={value}
      onValueChange={next => {
        const chosen = renditions.find(candidate => candidate === next);
        if (chosen !== undefined) onValueChange(chosen);
      }}
      className="gap-0"
    >
      <TabsList
        variant="line"
        size="sm"
        aria-label="Rendition"
        className="w-full justify-start border-b border-border px-3 pb-1"
      >
        {renditions.map(rendition => (
          <TabsTrigger key={rendition} value={rendition} className="flex-none">
            {renditionLabels[rendition]}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
};

/** The rows under the tabs, divided, inset as the card's summary is. */
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
