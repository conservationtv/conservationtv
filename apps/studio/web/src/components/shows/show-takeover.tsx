import { Suspense, type FC } from 'react';
import { useSuspenseQueries, useSuspenseQuery } from '@tanstack/react-query';
import { Badge } from '@conservationtv/ui/components/badge';
import { Button } from '@conservationtv/ui/components/button';
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from '@conservationtv/ui/components/native-select';
import { Skeleton } from '@conservationtv/ui/components/skeleton';

import { FormError } from '@/components/common/form-error';
import { StreamReachWarning } from '@/components/shows/show-reach';
import { SoundControl } from '@/components/shows/sound-control';
import { MoqPlayer } from '@/components/streams/moq-player';
import { useOrganisationId } from '@/hooks/use-organisation';
import { showQueryOptions, useMixShowStream, useUpdateShowControls, type OperatedShow } from '@/queries/shows';
import { streamListQueryOptions, streamMoqReadQueryOptions } from '@/queries/streams';

// A show's takeover (docs/shows.md): a mode of the show, not a slot. Arming a stream places it off air, so its picture
// is already playing when it is cut to; taking over puts it on air in place of the grid, whose state is untouched and
// comes back when the takeover ends. Any stream can take over: those with no camera (a phone, a PC, OBS) are what it is
// for, so they are offered first, but a camera may go solo too.

export interface ShowTakeoverProps {
  showId: string;
}

/**
 * Chooses what is armed, and takes over or ends it, with the armed stream's own preview: nothing armed; armed, not on
 * air (**Take over**); on air (**End takeover**). Any member.
 */
export const ShowTakeover: FC<ShowTakeoverProps> = ({ showId }) => {
  const organisationId = useOrganisationId();
  const update = useUpdateShowControls(organisationId, showId);
  const [showQuery, streamsQuery] = useSuspenseQueries({
    queries: [showQueryOptions(organisationId, showId), streamListQueryOptions(organisationId)]
  });
  const { takeoverStreamId, takeoverLive, lineup } = showQuery.data;
  const streams = streamsQuery.data;
  // The lineup lists every camera stream of the organisation, in it or not: any other stream has no camera.
  const cameraIds = new Set(lineup.map(stream => stream.streamId));
  const others = streams.filter(stream => !cameraIds.has(stream.id));
  const cameras = streams.filter(stream => cameraIds.has(stream.id));
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span id={`${showId}-takeover`} className="text-custom-13 text-muted-foreground">
          Takeover
        </span>
        <div className="flex items-center gap-1">
          <TakeoverState armed={takeoverStreamId !== null} live={takeoverLive} />
          {showQuery.data.takeoverMix !== null && <TakeoverSound showId={showId} mix={showQuery.data.takeoverMix} />}
        </div>
      </div>
      <NativeSelect
        className="w-full"
        aria-labelledby={`${showId}-takeover`}
        value={takeoverStreamId ?? ''}
        disabled={takeoverLive}
        onChange={event => update.mutate({ takeoverStreamId: event.target.value || null })}
      >
        <NativeSelectOption value="">Nothing armed</NativeSelectOption>
        {others.length > 0 && (
          <NativeSelectOptGroup label="Phones, PCs and OBS">
            {others.map(stream => (
              <NativeSelectOption key={stream.id} value={stream.id}>
                {optionLabel(stream)}
              </NativeSelectOption>
            ))}
          </NativeSelectOptGroup>
        )}
        {cameras.length > 0 && (
          <NativeSelectOptGroup label="Cameras, solo">
            {cameras.map(stream => (
              <NativeSelectOption key={stream.id} value={stream.id}>
                {optionLabel(stream)}
              </NativeSelectOption>
            ))}
          </NativeSelectOptGroup>
        )}
      </NativeSelect>
      {takeoverStreamId !== null && (
        <>
          <StreamReachWarning showId={showId} streamId={takeoverStreamId} />
          <Suspense fallback={<Skeleton className="aspect-video w-full rounded-md" />}>
            <TakeoverPreview key={takeoverStreamId} streamId={takeoverStreamId} />
          </Suspense>
          {takeoverLive ? (
            <Button
              variant="destructive"
              loading={update.isPending}
              onClick={() => update.mutate({ takeoverLive: false })}
            >
              End takeover
            </Button>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                disabled={update.isPending}
                onClick={() => update.mutate({ takeoverStreamId: null })}
              >
                Disarm
              </Button>
              <Button loading={update.isPending} onClick={() => update.mutate({ takeoverLive: true })}>
                Take over
              </Button>
            </div>
          )}
        </>
      )}
      <FormError error={update.error} />
    </div>
  );
};

interface TakeoverSoundProps {
  showId: string;
  mix: NonNullable<OperatedShow['takeoverMix']>;
}

/**
 * How the show mixes the armed stream's sound, which is heard only while the takeover is on air. A stream with no
 * camera is in no lineup, so this is the only place its level and mute are set.
 */
const TakeoverSound: FC<TakeoverSoundProps> = ({ showId, mix }) => {
  const organisationId = useOrganisationId();
  const update = useMixShowStream(organisationId, showId);
  return (
    <SoundControl
      label={mix.name}
      volumeDb={mix.volumeDb}
      muted={mix.muted}
      error={update.error}
      onSoundChange={change => update.mutate({ streamId: mix.streamId, ...change })}
    />
  );
};

/** What a stream is called among the choices. */
interface NamedStream {
  code: string | null;
  name: string;
}

/** A stream as a choice: its code and name, or its name. */
function optionLabel(stream: NamedStream): string {
  return stream.code ? `${stream.code} · ${stream.name}` : stream.name;
}

interface TakeoverStateProps {
  armed: boolean;
  live: boolean;
}

/** Where the takeover is: on air in place of the grid, armed and ready to cut to, or nothing armed. */
const TakeoverState: FC<TakeoverStateProps> = ({ armed, live }) => {
  if (live) {
    return (
      <Badge variant="destructive" title="It is on air in place of the grid, whose cameras are released.">
        On air
      </Badge>
    );
  }
  if (armed) {
    return (
      <Badge variant="outline" title="It is playing off air, ready to cut to.">
        Armed, not on air
      </Badge>
    );
  }
  return <span className="text-custom-12 text-muted-foreground">Nothing armed</span>;
};

interface TakeoverPreviewProps {
  streamId: string;
}

/**
 * The armed stream as it plays, by whatever delivers it to a browser, silent: what taking over would put on air. A
 * note shows through wherever it has no picture.
 */
const TakeoverPreview: FC<TakeoverPreviewProps> = ({ streamId }) => {
  const organisationId = useOrganisationId();
  const readQuery = useSuspenseQuery(streamMoqReadQueryOptions(organisationId, streamId));
  const read = readQuery.data;
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-md bg-black">
      <p className="absolute inset-0 flex items-center justify-center px-4 text-center text-custom-12 text-white/60">
        {'failure' in read ? `No preview: ${read.failure}` : 'No picture yet'}
      </p>
      {'failure' in read ? null : (
        <MoqPlayer
          url={read.url}
          broadcast={read.broadcast}
          className="relative block size-full object-contain opacity-0 data-picture:opacity-100"
        />
      )}
    </div>
  );
};
