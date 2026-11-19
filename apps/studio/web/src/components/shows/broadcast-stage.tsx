import type { FC } from 'react';
import { Stage, Stream, useStreamStatus } from '@strangecyan/vignette/react';
import { ShuffleIcon } from '@phosphor-icons/react';
import { Button } from '@conservationtv/ui/components/button';

import { FormError } from '@/components/common/form-error';
import { CtvStreamView } from '@/components/shows/ctv-stream-view';
import { useOrganisationId } from '@/hooks/use-organisation';
import { api } from '@/lib/api';
import { useComposeShow } from '@/queries/shows';

// A show's broadcast (apps/studio/api/src/shows): what is on screen, composed by the show's own object and followed by
// its stage here, by the outputs following it on their agents, with Compose beside it until a show has controls.

/** The source kinds a broadcast places beyond vignette's built-ins. */
const SOURCES = [CtvStreamView];

export interface BroadcastStageProps {
  showId: string;
}

/**
 * A show's broadcast, followed from its object in the API (apps/studio/api/src/shows/host.tsx) at the WebSocket address
 * the SDK gives, which `<Stream>` follows by its scheme, and rendered by vignette's React target. Every connection is
 * sent setup and the latest update first, so `<Stream>` simply redials with backoff when it drops (or is refused,
 * before the first Compose). The session cookie travels with the upgrade, as with every call to the API. Keyed by the
 * show where it is used: another show is another stream, so it starts over.
 */
export const BroadcastStage: FC<BroadcastStageProps> = ({ showId }) => {
  const organisationId = useOrganisationId();
  const url = api.organisations.shows.follow({ id: organisationId, showId });
  return (
    <Stream url={url} sources={SOURCES}>
      <div className="flex flex-col gap-2">
        <Stage className="w-full overflow-hidden rounded-lg bg-black" />
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <BroadcastStatus />
          <ComposeButton showId={showId} />
        </div>
      </div>
    </Stream>
  );
};

/** Where the stage is with the stream: still connecting, caught up, or why it isn't. */
const BroadcastStatus: FC = () => {
  const status = useStreamStatus();
  const settled = status.revision.settled;
  return (
    <p className="text-custom-12 text-muted-foreground tabular-nums">
      {status.error ? `Can’t show the broadcast: ${status.error.message}` : status.phase}
      {settled === undefined ? null : ` · revision ${String(settled)}`}
    </p>
  );
};

/**
 * Temporary, until a show has controls: composes the show from the organisation's streams, in a random order, for
 * everyone watching and every output following it. Any member may.
 */
const ComposeButton: FC<BroadcastStageProps> = ({ showId }) => {
  const organisationId = useOrganisationId();
  const compose = useComposeShow(organisationId);
  return (
    <div className="flex items-center gap-3">
      <FormError error={compose.error} />
      <span className="text-custom-12 text-muted-foreground">Rearranges it for every output following it</span>
      <Button variant="outline" size="sm" loading={compose.isPending} onClick={() => compose.mutate(showId)}>
        <ShuffleIcon />
        Compose
      </Button>
    </div>
  );
};
