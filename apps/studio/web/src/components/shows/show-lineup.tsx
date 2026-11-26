import type { ComponentProps, FC } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { CloudSlashIcon, LockIcon, ProhibitIcon } from '@phosphor-icons/react';
import { NativeSelect, NativeSelectOption } from '@conservationtv/ui/components/native-select';

import { FormError } from '@/components/common/form-error';
import { StreamReachWarning } from '@/components/shows/show-reach';
import { SoundControl } from '@/components/shows/sound-control';
import { StreamCode } from '@/components/streams/stream-code';
import { useOrganisationId } from '@/hooks/use-organisation';
import { showQueryOptions, useMixShowStream, useSwapLineup, type LineupStream } from '@/queries/shows';

// A show's lineup as its controls operate it (docs/shows.md): its cameras in order, one row per position, the first
// `slots` on screen. Choosing another stream in a row swaps the two, by stream, never by position; each row also sets
// how the show mixes that stream's sound, and warns of any output following the show that cannot reach it. The
// organisation's cameras out of the lineup follow, greyed, saying why.

export interface ShowLineupProps {
  showId: string;
}

/** One row per position in the lineup, then the cameras out of it. Any member. */
export const ShowLineup: FC<ShowLineupProps> = ({ showId }) => {
  const organisationId = useOrganisationId();
  const swap = useSwapLineup(organisationId, showId);
  const showQuery = useSuspenseQuery(showQueryOptions(organisationId, showId));
  const { slots, lineup } = showQuery.data;
  const inLineup = lineup.filter(stream => stream.position !== null);
  const absent = lineup.filter(stream => stream.position === null);
  if (lineup.length === 0) {
    return (
      <p className="text-custom-13 text-muted-foreground">
        The organisation has no camera streams yet. A stream whose source is a camera joins the lineup once it is
        delivered.
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
              onChoose={chosen => swap.mutate({ a: stream.streamId, b: chosen })}
            />
          </li>
        ))}
      </ol>
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
  /** Swaps the chosen stream into this position, and this one into the chosen stream's. */
  onChoose: (streamId: string) => void;
}

/**
 * A position: the code of the stream in it, the stream chosen from the lineup, and how its sound is mixed; under them,
 * any output that cannot reach it.
 */
const LineupRow: FC<LineupRowProps> = ({ showId, stream, lineup, onChoose }) => {
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
            <NativeSelectOption key={option.streamId} value={option.streamId}>
              {option.code ? `${option.code} · ${option.name}` : option.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <StreamSound showId={showId} stream={stream} />
      </div>
      <StreamReachWarning showId={showId} streamId={stream.streamId} className="pl-10.5" />
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
