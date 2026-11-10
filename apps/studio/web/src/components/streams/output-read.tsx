import { Suspense, useState, type FC, type ReactNode } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { BroadcastIcon, CheckIcon, CopyIcon, LinkIcon } from '@phosphor-icons/react';
import type { Rendition } from '@conservationtv/studio-sdk';
import { Button } from '@conservationtv/ui/components/button';
import { Skeleton } from '@conservationtv/ui/components/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@conservationtv/ui/components/tooltip';

import {
  ReadRow,
  ReadRowActions,
  ReadRowHeading,
  ReadRowNote,
  ReadRows,
  ReadRowTitle,
  RenditionTabs
} from '@/components/streams/read-parts';
import { RENDITIONS } from '@/components/streams/renditions';
import { useCopy } from '@/hooks/use-copy';
import { useOrganisationId } from '@/hooks/use-organisation';
import { moqReadQueryOptions } from '@/queries/streams';

// How anyone reads a delivery to conservation.tv: over MoQ, from its relay. One connection carries the delivery's
// every rendition, each a track of one broadcast, so the renditions' tabs say what it offers and the way to read it is
// the same under each: the relay's URL with a read token in it, and the broadcast to subscribe to.

export interface MoqReadProps {
  streamId: string;
  exposureId: string;
  /** The renditions the delivery offers: every one a track of the same broadcast. */
  renditions: Rendition[];
}

/** The delivery's renditions as tabs, and beneath them how to read it over MoQ. */
export const MoqRead: FC<MoqReadProps> = ({ streamId, exposureId, renditions }) => {
  const offered = RENDITIONS.filter(rendition => renditions.includes(rendition));
  const [selected, setSelected] = useState<Rendition | undefined>(offered[0]);
  if (selected === undefined) return null;
  return (
    <>
      <RenditionTabs renditions={offered} value={selected} onValueChange={setSelected} />
      <ReadRows>
        <ReadRow>
          <ReadRowHeading>
            <ReadRowTitle>MoQ</ReadRowTitle>
            <ReadRowNote>From anywhere: every rendition is a track of one broadcast</ReadRowNote>
          </ReadRowHeading>
          {/* The heading is known already; only the buttons wait, behind a placeholder their height. */}
          <Suspense fallback={<Skeleton className="h-7 w-52" />}>
            <MoqReadActions streamId={streamId} exposureId={exposureId} />
          </Suspense>
        </ReadRow>
      </ReadRows>
    </>
  );
};

interface MoqReadActionsProps {
  streamId: string;
  exposureId: string;
}

/**
 * The relay URL, with this account's read token in it as `?jwt=`, and the broadcast, each copied by a button; or why
 * the API wouldn't give them.
 */
const MoqReadActions: FC<MoqReadActionsProps> = ({ streamId, exposureId }) => {
  const organisationId = useOrganisationId();
  const readQuery = useSuspenseQuery(moqReadQueryOptions(organisationId, streamId, exposureId));
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
        <span>A MoQ player subscribes to it at the relay, and picks a rendition among its tracks.</span>
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
