import type { FC } from 'react';
import { Stage, Stream, useStreamStatus } from '@strangecyan/vignette/react';
import { ShuffleIcon } from '@phosphor-icons/react';
import { Button } from '@conservationtv/ui/components/button';

import { FormError } from '@/components/common/form-error';
import { CtvStreamView } from '@/components/shows/ctv-stream-view';
import { useOrganisationId } from '@/hooks/use-organisation';
import { api } from '@/lib/api';
import { useComposeBroadcast } from '@/queries/shows';

// The organisation's one broadcast, which every one of its shows follows for now (apps/studio/api/src/shows): what is
// on screen is the broadcast's, so its stage and Compose are the organisation's too, whichever show's page they are on.

/** The source kinds a broadcast places beyond vignette's built-ins. */
const SOURCES = [CtvStreamView];

/**
 * The organisation's broadcast, followed from the API's show object (apps/studio/api/src/shows/host.tsx) at the
 * WebSocket address the SDK gives, which `<Stream>` follows by its scheme, and rendered by vignette's React target.
 * Every connection is sent setup and the latest update first, so `<Stream>` simply redials with backoff when it drops
 * (or is refused, before the first Compose). The session cookie travels with the upgrade, as with every call to the
 * API. Keyed by the organisation where it is used: a new organisation is a new stream, so it starts over.
 */
export const BroadcastStage: FC = () => {
  const organisationId = useOrganisationId();
  const url = api.organisations.show.follow({ id: organisationId });
  return (
    <Stream url={url} sources={SOURCES}>
      <div className="flex flex-col gap-2">
        <Stage className="w-full overflow-hidden rounded-lg bg-black" />
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <BroadcastStatus />
          <ComposeButton />
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
 * Temporary, until a show has controls: composes the broadcast from the organisation's streams, in a random order, for
 * every show and everyone watching. Any member may.
 */
const ComposeButton: FC = () => {
  const organisationId = useOrganisationId();
  const compose = useComposeBroadcast(organisationId);
  return (
    <div className="flex items-center gap-3">
      <FormError error={compose.error} />
      <span className="text-custom-12 text-muted-foreground">Rearranges it for every show</span>
      <Button variant="outline" size="sm" loading={compose.isPending} onClick={() => compose.mutate()}>
        <ShuffleIcon />
        Compose
      </Button>
    </div>
  );
};
