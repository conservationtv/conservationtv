import { Suspense, useEffect, useRef, type FC, type ReactNode } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { Skeleton } from '@conservationtv/ui/components/skeleton';

import { useOrganisationId } from '@/hooks/use-organisation';
import { moqReadQueryOptions, streamListQueryOptions } from '@/queries/streams';

// A temporary live preview of a stream, played over MoQ from the built-in conservation.tv gateway: the only gateway
// readers reach by MoQ (src/gateways/conservationtv.ts in the studio API). Muted, and playing whether or not it's on
// screen.

/** The built-in gateway that serves MoQ to readers, by its slug. */
const MOQ_GATEWAY = 'conservationtv';

export interface CTVMoQPreviewProps {
  /** The stream's ID. */
  stream: string;
}

/** The stream, live, from its conservation.tv exposure; a note in its place when it has none or can't be read. */
export const CTVMoQPreview: FC<CTVMoQPreviewProps> = ({ stream }) => {
  return (
    <Suspense fallback={<Skeleton className="aspect-video w-full rounded-lg" />}>
      <PreviewSource streamId={stream} />
    </Suspense>
  );
};

interface PreviewSourceProps {
  streamId: string;
}

/** Finds the stream's MoQ exposure and asks where to watch it. */
const PreviewSource: FC<PreviewSourceProps> = ({ streamId }) => {
  const organisationId = useOrganisationId();
  const exposureQuery = useSuspenseQuery({
    ...streamListQueryOptions(organisationId),
    select: streams =>
      streams
        .find(candidate => candidate.id === streamId)
        ?.exposures.find(exposure => exposure.gatewayId === MOQ_GATEWAY)
  });
  const exposure = exposureQuery.data;
  if (!exposure) return <PreviewNote>Not delivered to conservation.tv, so there’s no preview.</PreviewNote>;
  return <PreviewConnection streamId={streamId} exposureId={exposure.id} />;
};

interface PreviewConnectionProps {
  streamId: string;
  exposureId: string;
}

const PreviewConnection: FC<PreviewConnectionProps> = ({ streamId, exposureId }) => {
  const organisationId = useOrganisationId();
  const readQuery = useSuspenseQuery(moqReadQueryOptions(organisationId, streamId, exposureId));
  const read = readQuery.data;
  if ('failure' in read) return <PreviewNote>Preview unavailable: {read.failure}</PreviewNote>;
  return <PreviewPlayer url={read.url} broadcast={read.broadcast} />;
};

interface PreviewPlayerProps {
  url: string;
  broadcast: string;
}

/** Plays the broadcast into a canvas, reconnecting when the credential in its URL is renewed. */
const PreviewPlayer: FC<PreviewPlayerProps> = ({ url, broadcast }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // The player is loaded only once one mounts, so the page doesn't carry it until a preview plays.
    let release: (() => void) | undefined = undefined;
    let unmounted = false;
    void import('@moq/watch').then(Watch => {
      if (unmounted) return;
      const connection = new Watch.Net.Connection({ url: new URL(url), enabled: true });
      const player = new Watch.Player({
        origin: connection.origin,
        probe: connection.probe,
        name: Watch.Net.Path.from(broadcast),
        canvas,
        enabled: true,
        muted: true,
        // Keep downloading and drawing video off screen and in a background tab, rather than pausing until it's seen.
        visible: 'always'
      });
      release = () => {
        player.close();
        connection.close();
      };
    });
    return () => {
      unmounted = true;
      release?.();
    };
  }, [url, broadcast]);
  return <canvas ref={canvasRef} className="aspect-video w-full rounded-lg bg-muted" />;
};

interface PreviewNoteProps {
  children: ReactNode;
}

const PreviewNote: FC<PreviewNoteProps> = ({ children }) => {
  return (
    <div className="flex aspect-video w-full items-center justify-center rounded-lg bg-muted px-6 text-center text-custom-13 text-muted-foreground">
      {children}
    </div>
  );
};
