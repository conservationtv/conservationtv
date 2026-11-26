import type { ComponentProps, FC } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { BroadcastIcon, CloudSlashIcon, LockIcon, ProhibitIcon } from '@phosphor-icons/react';
import { Button } from '@conservationtv/ui/components/button';
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from '@conservationtv/ui/components/native-select';

import { FormError } from '@/components/common/form-error';
import { StreamReachWarning } from '@/components/shows/show-reach';
import { SoundControl } from '@/components/shows/sound-control';
import { StreamCode } from '@/components/streams/stream-code';
import { useOrganisationId } from '@/hooks/use-organisation';
import { showQueryOptions, useMixShowStream, useSwapLineup, type LineupStream } from '@/queries/shows';

// A show's lineup as its controls operate it (docs/shows.md): its streams in order, one row per position, the first
// `slots` on screen. Choosing another stream in a row swaps the two, by stream, never by position; each row also sets
// how the show mixes that stream's sound, and warns of any output following the show that cannot reach it. Streams
// going live (a phone, a PC, OBS) wait on standby until someone chooses one for a position, or puts it in an empty
// slot: nothing goes on air by itself. The organisation's cameras out of the lineup follow, greyed, saying why.

export interface ShowLineupProps {
  showId: string;
}

/** One row per position in the lineup, then the streams on standby, then the cameras out of it. Any member. */
export const ShowLineup: FC<ShowLineupProps> = ({ showId }) => {
  const organisationId = useOrganisationId();
  const swap = useSwapLineup(organisationId, showId);
  const showQuery = useSuspenseQuery(showQueryOptions(organisationId, showId));
  const { slots, lineup } = showQuery.data;
  const inLineup = lineup.filter(stream => stream.position !== null);
  const standby = lineup.filter(stream => stream.absence === 'standby');
  const absent = lineup.filter(stream => stream.position === null && stream.absence !== 'standby');
  // The first empty slot, while the lineup doesn't fill the layout: where a stream on standby can go.
  const emptySlot = inLineup.length < slots ? inLineup.length + 1 : undefined;
  if (lineup.length === 0) {
    return (
      <p className="text-custom-13 text-muted-foreground">
        The organisation has no camera streams yet. A stream whose source is a camera joins the lineup once it is
        delivered; one going live waits here to be put on.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <FormError error={swap.error} />
      <ol className="flex flex-col gap-1.5" aria-label="Lineup">
        {inLineup.map(stream => (
          <li key={stream.streamId} className="flex flex-col gap-1.5">
            {stream.position === slots + 1 && <OffScreenDivider />}
            <LineupRow
              showId={showId}
              stream={stream}
              lineup={inLineup}
              standby={standby}
              onChoose={chosen => swap.mutate({ a: stream.streamId, b: chosen })}
            />
          </li>
        ))}
      </ol>
      {standby.length > 0 && (
        <ul className="flex flex-col gap-1.5" aria-label="Live, on standby">
          {standby.map(stream => (
            <li key={stream.streamId}>
              <StandbyRow
                showId={showId}
                stream={stream}
                onPutOn={
                  emptySlot === undefined ? undefined : () => swap.mutate({ a: stream.streamId, slot: emptySlot })
                }
              />
            </li>
          ))}
        </ul>
      )}
      {absent.length > 0 && (
        <ul className="flex flex-col gap-1.5" aria-label="Out of the lineup">
          {absent.map(stream => (
            <li key={stream.streamId}>
              <AbsentRow stream={stream} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

/** Where the lineup goes off screen: the positions after it wait to be swapped on. */
const OffScreenDivider: FC = () => {
  return (
    <div className="flex items-center gap-2 pt-1 text-custom-12 text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      Off screen
      <span className="h-px flex-1 bg-border" />
    </div>
  );
};

interface LineupRowProps {
  showId: string;
  stream: LineupStream;
  /** The streams in the lineup, any of which may be chosen for this position. */
  lineup: LineupStream[];
  /** The streams going live on standby, any of which may be chosen for this position too. */
  standby: LineupStream[];
  /** Swaps the chosen stream into this position, and this one into the chosen stream's. */
  onChoose: (streamId: string) => void;
}

/**
 * A position: the code of the stream in it, the stream chosen from the lineup, and how its sound is mixed; under them,
 * any output that cannot reach it.
 */
const LineupRow: FC<LineupRowProps> = ({ showId, stream, lineup, standby, onChoose }) => {
  const position = stream.position ?? 0;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <StreamCode aria-hidden className="h-7">
          {stream.code ?? String(position)}
        </StreamCode>
        <NativeSelect
          className="min-w-0 flex-1"
          aria-label={`Position ${String(position)}`}
          value={stream.streamId}
          onChange={event => {
            if (event.target.value !== stream.streamId) onChoose(event.target.value);
          }}
        >
          {lineup.map(option => (
            <StreamOption key={option.streamId} stream={option} />
          ))}
          {standby.length > 0 && (
            <NativeSelectOptGroup label="Live, on standby">
              {standby.map(option => (
                <StreamOption key={option.streamId} stream={option} />
              ))}
            </NativeSelectOptGroup>
          )}
        </NativeSelect>
        <StreamSound showId={showId} stream={stream} />
      </div>
      <StreamReachWarning showId={showId} streamId={stream.streamId} className="pl-10.5" />
    </div>
  );
};

interface StreamOptionProps {
  stream: LineupStream;
}

/** A stream to choose for a position, by its code and name. */
const StreamOption: FC<StreamOptionProps> = ({ stream }) => {
  return (
    <NativeSelectOption value={stream.streamId}>
      {stream.code ? `${stream.code} · ${stream.name}` : stream.name}
    </NativeSelectOption>
  );
};

interface StandbyRowProps {
  showId: string;
  stream: LineupStream;
  /** Puts it in the first empty slot; absent while every slot is filled. */
  onPutOn: (() => void) | undefined;
}

/**
 * A stream going live, waiting to be put on: on screen in an empty slot while there is one, or chosen for a position
 * above. Its sound can be set before it goes on.
 */
const StandbyRow: FC<StandbyRowProps> = ({ showId, stream, onPutOn }) => {
  return (
    <div className="flex items-center gap-1.5">
      <StreamCode aria-hidden className="h-7">
        {stream.code ?? '–'}
      </StreamCode>
      <div className="flex h-7 min-w-0 flex-1 items-center justify-between gap-2 rounded-md border border-input px-2 text-xs/relaxed">
        <span className="truncate">{stream.name}</span>
        <Reason>
          <BroadcastIcon />
          Live
        </Reason>
      </div>
      {onPutOn !== undefined && (
        <Button size="sm" variant="outline" className="h-7" onClick={onPutOn}>
          Put on screen
        </Button>
      )}
      <StreamSound showId={showId} stream={stream} />
    </div>
  );
};

interface StreamSoundProps {
  showId: string;
  stream: LineupStream;
}

/** How the show mixes one stream's sound, kept for the show whether or not the stream is on screen. */
const StreamSound: FC<StreamSoundProps> = ({ showId, stream }) => {
  const organisationId = useOrganisationId();
  const mix = useMixShowStream(organisationId, showId);
  return (
    <SoundControl
      label={stream.name}
      volumeDb={stream.volumeDb}
      muted={stream.muted}
      error={mix.error}
      onSoundChange={change => mix.mutate({ streamId: stream.streamId, ...change })}
    />
  );
};

interface AbsentRowProps {
  stream: LineupStream;
}

/** A camera out of the lineup, greyed, with why: it joins at the end once that is no longer so. */
const AbsentRow: FC<AbsentRowProps> = ({ stream }) => {
  return (
    <div className="flex items-center gap-1.5 opacity-60" aria-disabled>
      <StreamCode aria-hidden className="h-7">
        {stream.code ?? '–'}
      </StreamCode>
      <div className="flex h-7 min-w-0 flex-1 items-center justify-between gap-2 rounded-md border border-dashed border-input px-2 text-xs/relaxed">
        <span className="truncate">{stream.name}</span>
        <AbsenceReason absence={stream.absence} />
      </div>
      {/* Where the sound control is on a row in the lineup, so the names line up. */}
      <span className="size-6 shrink-0" />
    </div>
  );
};

interface AbsenceReasonProps {
  absence: LineupStream['absence'];
}

/** Why a camera is out of the lineup, in a word with its icon. */
const AbsenceReason: FC<AbsenceReasonProps> = ({ absence }) => {
  if (absence === 'locked') {
    return (
      <Reason>
        <LockIcon />
        Locked
      </Reason>
    );
  }
  if (absence === 'disabled') {
    return (
      <Reason>
        <ProhibitIcon />
        Disabled
      </Reason>
    );
  }
  if (absence === 'undelivered') {
    return (
      <Reason>
        <CloudSlashIcon />
        Not delivered
      </Reason>
    );
  }
  return null;
};

/** A reason, an icon then a word. */
const Reason: FC<ComponentProps<'span'>> = props => {
  return <span className="flex shrink-0 items-center gap-1 text-muted-foreground [&_svg]:size-3.5" {...props} />;
};
