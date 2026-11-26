import { Suspense, type FC, type ReactNode } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { BroadcastIcon, CheckIcon, CopyIcon, LinkIcon } from '@phosphor-icons/react';
import { Button } from '@conservationtv/ui/components/button';
import { Skeleton } from '@conservationtv/ui/components/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@conservationtv/ui/components/tooltip';

import {
  ReadRow,
  ReadRowActions,
  ReadRowHeading,
  ReadRowNote,
  ReadRows,
  ReadRowTitle
} from '@/components/streams/read-parts';
import { useCopy } from '@/hooks/use-copy';
import type { MoqReadQueryOptions } from '@/queries/streams';

// How anyone reads something at conservation.tv, a stream's delivery or a show's preview: over MoQ, from its relay.
// One broadcast carries it, its catalog listing the pictures it has by their sizes, so a player picks the size it
// needs itself: the way to read it is the relay's URL with a read token in it, and the broadcast to subscribe to.

export interface MoqReadProps {
  /** Its connection: `moqReadQueryOptions` for a stream's delivery, `previewMoqReadQueryOptions` for a show's preview. */
  read: MoqReadQueryOptions;
}

/** How to read it over MoQ. */
export const MoqRead: FC<MoqReadProps> = ({ read }) => {
  return (
    <ReadRows>
      <ReadRow>
        <ReadRowHeading>
          <ReadRowTitle>MoQ</ReadRowTitle>
          <ReadRowNote>From anywhere: a player picks the size it needs from one broadcast</ReadRowNote>
        </ReadRowHeading>
        {/* The heading is known already; only the buttons wait, behind a placeholder their height. */}
        <Suspense fallback={<Skeleton className="h-7 w-52" />}>
          <MoqReadActions read={read} />
        </Suspense>
      </ReadRow>
    </ReadRows>
  );
};

interface MoqReadActionsProps {
  read: MoqReadQueryOptions;
}

/**
 * The relay URL, with this account's read token in it as `?jwt=`, and the broadcast, each copied by a button; or why
 * the API wouldn't give them.
 */
const MoqReadActions: FC<MoqReadActionsProps> = ({ read: query }) => {
  const readQuery = useSuspenseQuery(query);
  const read = readQuery.data;
  if ('failure' in read)
    return <span className="max-w-sm text-custom-12 text-custom-text-secondary">{read.failure}</span>;
  return (
    <ReadRowActions>
      <CopyValueButton value={read.url} icon={<LinkIcon />} label="Relay URL">
        <span className="font-medium">Copies the relay’s URL, with a read token in it.</span>
        <span>Give it to a MoQ player, such as the moq CLI or @moq/watch, with the broadcast name beside it.</span>
        <span className="opacity-80">The token lasts an hour; copy it again after that.</span>
      </CopyValueButton>
      <CopyValueButton value={read.broadcast} icon={<BroadcastIcon />} label="Broadcast">
        <span className="font-medium">Copies the broadcast’s name.</span>
        <span>A MoQ player subscribes to it at the relay, and picks the size it needs from its catalog.</span>
      </CopyValueButton>
    </ReadRowActions>
  );
};

interface CopyValueButtonProps {
  value: string;
  icon: ReactNode;
  /** What the button says. */
  label: string;
  /** The tooltip's lines: what pressing it copies, then how to use it. */
  children: ReactNode;
}

/** A button that copies a value, its tooltip saying what it is and how to use it. */
const CopyValueButton: FC<CopyValueButtonProps> = ({ value, icon, label, children }) => {
  const { copied, copy } = useCopy();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            aria-label={`Copy the ${label.toLowerCase()}`}
            onClick={() => copy(value)}
          />
        }
      >
        {icon}
        {label}
        {copied ? <CheckIcon /> : <CopyIcon />}
      </TooltipTrigger>
      <TooltipContent className="max-w-xs flex-col items-start gap-1.5 py-2 text-left">{children}</TooltipContent>
    </Tooltip>
  );
};
