import { useEffect, useEffectEvent, type FC } from 'react';
import { useSuspenseQueries } from '@tanstack/react-query';
import { BroadcastIcon, XIcon } from '@phosphor-icons/react';
import { Button } from '@conservationtv/ui/components/button';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle
} from '@conservationtv/ui/components/item';

import { FormError } from '@/components/common/form-error';
import { useOrganisationId } from '@/hooks/use-organisation';
import { liveExposureListQueryOptions, liveStreamIds, offlineStreamIds } from '@/queries/publishing';
import { showQueryOptions, useUpdateShowControls } from '@/queries/shows';
import { streamListQueryOptions } from '@/queries/streams';
import { liveSourceDismissalsQueryOptions, useSetLiveSourceDismissals } from '@/queries/this-device';

// A show's prompt for a stream that has just gone live (docs/shows.md, Going live): a pushed stream (no source of its
// own: a phone, a PC, OBS) that one of its deliveries' gateways says is live now, and that is not already the show's
// takeover, with **Preview** (arm it, off air: not while another takeover is on air, which arming would replace) and
// **Take over** (arm it and put it on air). Dismissing one is this
// viewer's alone, kept for this tab's visit, and lasts until a gateway says the stream is offline: nobody else's
// controls, and nothing of the show's, change.

export interface ShowLiveSourcesProps {
  showId: string;
}

/** Each pushed stream live now that the show could take over, offered until this viewer dismisses it; else nothing. */
export const ShowLiveSources: FC<ShowLiveSourcesProps> = ({ showId }) => {
  const organisationId = useOrganisationId();
  const update = useUpdateShowControls(organisationId, showId);
  const setDismissals = useSetLiveSourceDismissals(showId);
  const [showQuery, streamsQuery, liveQuery, dismissalsQuery] = useSuspenseQueries({
    queries: [
      showQueryOptions(organisationId, showId),
      streamListQueryOptions(organisationId),
      liveExposureListQueryOptions(organisationId),
      liveSourceDismissalsQueryOptions(showId)
    ]
  });
  const live = liveStreamIds(liveQuery.data);
  const offline = offlineStreamIds(liveQuery.data);
  const dismissals = dismissalsQuery.data;
  const dismissed = new Set(dismissals);
  // A dismissal lasts until its stream is said to be offline: then it is forgotten, so going live again prompts. A
  // gateway that cannot say, or a moment between deliveries, is not offline.
  const kept = dismissals.filter(streamId => !offline.has(streamId));
  const forgetting = kept.length !== dismissals.length;
  const forget = useEffectEvent(() => setDismissals.mutate(kept));
  useEffect(() => {
    if (forgetting) forget();
  }, [forgetting]);
  const { takeoverStreamId, takeoverLive } = showQuery.data;
  const offered = streamsQuery.data.filter(
    stream =>
      stream.sourceDeviceId === null &&
      live.has(stream.id) &&
      stream.id !== takeoverStreamId &&
      !dismissed.has(stream.id)
  );
  if (offered.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <ItemGroup className="gap-2">
        {offered.map(stream => (
          <Item key={stream.id} variant="outline" size="sm" aria-live="polite">
            <ItemContent className="min-w-0">
              <ItemTitle className="flex items-center gap-1.5">
                <BroadcastIcon className="text-destructive" />
                <span className="truncate">{stream.name}</span>
              </ItemTitle>
              <ItemDescription>Just went live</ItemDescription>
            </ItemContent>
            <ItemActions>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Dismiss ${stream.name}`}
                onClick={() => setDismissals.mutate([...dismissals, stream.id])}
              >
                <XIcon />
              </Button>
            </ItemActions>
            <div className="grid w-full grid-cols-2 gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={update.isPending || takeoverLive}
                title={
                  takeoverLive ? 'Another takeover is on air: arming this would put it on air instead.' : undefined
                }
                onClick={() => update.mutate({ takeoverStreamId: stream.id })}
              >
                Preview
              </Button>
              <Button
                size="sm"
                disabled={update.isPending}
                onClick={() => update.mutate({ takeoverStreamId: stream.id, takeoverLive: true })}
              >
                Take over
              </Button>
            </div>
          </Item>
        ))}
      </ItemGroup>
      <FormError error={update.error} />
    </div>
  );
};
