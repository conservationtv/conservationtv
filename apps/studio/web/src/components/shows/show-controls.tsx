import type { ComponentProps, FC } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { cn } from '@conservationtv/ui/lib/utils';

import { SoundControl } from '@/components/shows/sound-control';
import { useOrganisationId } from '@/hooks/use-organisation';
import { showQueryOptions, useUpdateShowControls } from '@/queries/shows';

// The frame of a show's controls, beside its stage, which the page fills with the controls it places (the layout,
// the lineup, the takeover): any member operates a show.

/** A show's stage and its controls, side by side where there is room, the controls below it where there isn't. */
export const ShowDesk: FC<ComponentProps<'div'>> = ({ className, ...props }) => {
  return <div className={cn('grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]', className)} {...props} />;
};

/** The column of a show's controls: a stack of `ShowControlsSection`s. */
export const ShowControls: FC<ComponentProps<'aside'>> = ({ className, ...props }) => {
  return <aside aria-label="Show controls" className={cn('flex min-w-0 flex-col', className)} {...props} />;
};

/** One group of a show's controls, ruled off from the one before it. */
export const ShowControlsSection: FC<ComponentProps<'section'>> = ({ className, ...props }) => {
  return (
    <section
      className={cn('flex flex-col gap-3 border-t border-border py-4 first:border-t-0 first:pt-0', className)}
      {...props}
    />
  );
};

export interface ShowMixProps {
  showId: string;
}

/** The show's own mix, over every stream's: its level, and whether it is muted. Any member. */
export const ShowMix: FC<ShowMixProps> = ({ showId }) => {
  const organisationId = useOrganisationId();
  const update = useUpdateShowControls(organisationId, showId);
  const mixQuery = useSuspenseQuery({
    ...showQueryOptions(organisationId, showId),
    select: show => ({ volumeDb: show.volumeDb, muted: show.muted })
  });
  const { volumeDb, muted } = mixQuery.data;
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-custom-13 text-muted-foreground">Show sound</span>
      <SoundControl
        label="The show"
        volumeDb={volumeDb}
        muted={muted}
        error={update.error}
        onSoundChange={change => update.mutate(change)}
      />
    </div>
  );
};
