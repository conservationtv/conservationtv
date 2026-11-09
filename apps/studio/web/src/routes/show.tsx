import type { FC } from 'react';
import { Stage, Stream, useStreamStatus } from '@strangecyan/vignette/react';
import { BroadcastIcon, ShuffleIcon } from '@phosphor-icons/react';
import { Link } from 'react-router';
import { Button } from '@conservationtv/ui/components/button';

import type { Route } from './+types/show';
import { CtvStreamView } from '@/components/shows/ctv-stream-view';
import { api } from '@/lib/api';
import { useComposeBroadcast } from '@/queries/shows';

export const meta: Route.MetaFunction = () => [{ title: 'Show · conservation.tv studio' }];

/** The source kinds a broadcast places beyond vignette's built-ins. */
const SOURCES = [CtvStreamView];

/**
 * The organisation's broadcast, as the studio API composes it (apps/studio/api/src/shows): followed live and rendered
 * by vignette's React target. For now it shows up to six cameras, one big and five small, chosen at random from the streams
 * delivered to conservation.tv each time someone presses Compose; until then there is nothing to follow.
 */
const ShowRoute: FC<Route.ComponentProps> = ({ params }) => {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-10 py-10">
      <header className="flex items-end justify-between gap-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-custom-21 font-semibold text-foreground">Show</h1>
          <p className="max-w-2xl text-custom-13 leading-(--leading-custom-body) text-custom-text-secondary">
            The organisation’s broadcast, live: up to six of its streams delivered to conservation.tv, one large and
            five small.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" nativeButton={false} render={<Link to="../channels" relative="path" />}>
            <BroadcastIcon />
            Channels
          </Button>
          <ComposeButton organisationId={params.organisationId} />
        </div>
      </header>
      {/* A new organisation is a new stream, so its broadcast starts over. */}
      <BroadcastStage key={params.organisationId} organisationId={params.organisationId} />
    </div>
  );
};

export default ShowRoute;

interface ComposeButtonProps {
  organisationId: string;
}

/** Temporary: composes the broadcast from the organisation's streams, in a random order, for everyone watching. */
const ComposeButton: FC<ComposeButtonProps> = ({ organisationId }) => {
  const compose = useComposeBroadcast(organisationId);
  return (
    <div className="flex items-center gap-3">
      {compose.error ? <span className="text-custom-13 text-destructive">{compose.error.message}</span> : null}
      <Button variant="outline" size="sm" disabled={compose.isPending} onClick={() => compose.mutate()}>
        <ShuffleIcon />
        Compose
      </Button>
    </div>
  );
};

interface BroadcastStageProps {
  organisationId: string;
}

/**
 * The organisation's broadcast, followed from the API's show object (apps/studio/api/src/shows/host.tsx) at the
 * WebSocket address the SDK gives, which `<Stream>` follows by its scheme. Every connection is sent setup and the latest
 * update first, so `<Stream>` simply redials with backoff when it drops (or is refused, before the first Compose). The
 * session cookie travels with the upgrade, as with every call to the API.
 */
const BroadcastStage: FC<BroadcastStageProps> = ({ organisationId }) => {
  const url = api.organisations.show.follow({ id: organisationId });
  return (
    <Stream url={url} sources={SOURCES}>
      <div className="flex flex-col gap-3">
        <Stage className="w-full overflow-hidden rounded-lg bg-black" />
        <BroadcastStatus />
      </div>
    </Stream>
  );
};

/** Where the stage is with the stream: still connecting, caught up, or why it isn't. */
const BroadcastStatus: FC = () => {
  const status = useStreamStatus();
  const settled = status.revision.settled;
  return (
    <p className="text-custom-13 text-muted-foreground tabular-nums">
      {status.error ? `Can’t show the broadcast: ${status.error.message}` : status.phase}
      {settled === undefined ? null : ` · revision ${String(settled)}`}
    </p>
  );
};
