import { useState, type ComponentProps, type FC } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { BroadcastIcon, CloudSlashIcon, LockIcon, PlusIcon, ProhibitIcon, XIcon } from '@phosphor-icons/react';
import { Button } from '@conservationtv/ui/components/button';
import { NativeSelect, NativeSelectOption } from '@conservationtv/ui/components/native-select';
import { Popover, PopoverContent, PopoverTrigger } from '@conservationtv/ui/components/popover';

import { FormError } from '@/components/common/form-error';
import { StreamReachWarning } from '@/components/shows/show-reach';
import { SoundControl } from '@/components/shows/sound-control';
import { StreamCode } from '@/components/streams/stream-code';
import { useOrganisationId } from '@/hooks/use-organisation';
import {
  showQueryOptions,
  useAddToLineup,
  useMixShowStream,
  useRemoveFromLineup,
  useSwapLineup,
  type AddableStream,
  type LineupStream
} from '@/queries/shows';

// A show's lineup as its controls operate it (docs/shows.md): the streams its operators put in it, in order, one row
// per position, the first `slots` on screen. Choosing another stream in a row swaps the two, by stream, never by
// position; each row also sets how the show mixes that stream's sound, takes it out of the lineup, and warns of any
// output following the show that cannot reach it. A camera that is locked keeps its row, greyed, and is skipped.
// "Add a stream" offers what could be added: the cameras out of the lineup, and streams going live.

export interface ShowLineupProps {
  showId: string;
}

/** The lineup in order, then a way to add to it. Any member. */
export const ShowLineup: FC<ShowLineupProps> = ({ showId }) => {
  const organisationId = useOrganisationId();
  const swap = useSwapLineup(organisationId, showId);
  const remove = useRemoveFromLineup(organisationId, showId);
  const showQuery = useSuspenseQuery(showQueryOptions(organisationId, showId));
  const { slots, lineup, addable } = showQuery.data;
  const positioned = lineup.filter(stream => stream.position !== null);
  return (
    <div className="flex flex-col gap-1.5">
      <FormError error={swap.error ?? remove.error} />
      {lineup.length === 0 ? (
        <p className="text-custom-13 text-muted-foreground">
          Nothing is in the lineup. A camera joins it once it is delivered; add a stream going live, or a camera taken
          out, below.
        </p>
      ) : (
        <ol className="flex flex-col gap-1.5" aria-label="Lineup">
          {lineup.map(stream => (
            <li key={stream.streamId} className="flex flex-col gap-1.5">
              {stream.position === slots + 1 && <OffScreenDivider />}
              {stream.position === null ? (
                <SkippedRow stream={stream} onRemove={() => remove.mutate(stream.streamId)} />
              ) : (
                <LineupRow
                  showId={showId}
                  stream={stream}
                  positioned={positioned}
                  onChoose={chosen => swap.mutate({ a: stream.streamId, b: chosen })}
                  onRemove={() => remove.mutate(stream.streamId)}
                />
              )}
            </li>
          ))}
        </ol>
      )}
      <AddStream showId={showId} addable={addable} />
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
  /** The streams in the lineup with a position, any of which may be chosen for this one. */
  positioned: LineupStream[];
  /** Swaps the chosen stream into this position, and this one into the chosen stream's. */
  onChoose: (streamId: string) => void;
  onRemove: () => void;
}

/**
 * A position: the code of the stream in it, the stream chosen from the lineup, how its sound is mixed, and taking it
 * out; under them, any output that cannot reach it.
 */
const LineupRow: FC<LineupRowProps> = ({ showId, stream, positioned, onChoose, onRemove }) => {
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
          {positioned.map(option => (
            <NativeSelectOption key={option.streamId} value={option.streamId}>
              {streamLabel(option)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <StreamSound showId={showId} stream={stream} />
        <RemoveButton name={stream.name} onRemove={onRemove} />
      </div>
      <StreamReachWarning showId={showId} streamId={stream.streamId} className="pl-10.5" />
    </div>
  );
};

interface SkippedRowProps {
  stream: LineupStream;
  onRemove: () => void;
}

/** A camera that is locked: greyed where it stands in the lineup, skipped until it is unlocked. */
const SkippedRow: FC<SkippedRowProps> = ({ stream, onRemove }) => {
  return (
    <div className="flex items-center gap-1.5">
      <StreamCode aria-hidden className="h-7 opacity-60">
        {stream.code ?? '–'}
      </StreamCode>
      <div
        className="flex h-7 min-w-0 flex-1 items-center justify-between gap-2 rounded-md border border-dashed border-input px-2 text-xs/relaxed opacity-60"
        aria-disabled
      >
        <span className="truncate">{stream.name}</span>
        <Reason>
          <LockIcon />
          Locked, skipped
        </Reason>
      </div>
      {/* Where the sound control is on a row with a position, so the names line up. */}
      <span className="size-6 shrink-0" />
      <RemoveButton name={stream.name} onRemove={onRemove} />
    </div>
  );
};

interface RemoveButtonProps {
  name: string;
  onRemove: () => void;
}

/** Takes a stream out of the lineup: the rest move up, and it can be added again. */
const RemoveButton: FC<RemoveButtonProps> = ({ name, onRemove }) => {
  return (
    <Button variant="ghost" size="icon-sm" aria-label={`Take ${name} out of the lineup`} onClick={onRemove}>
      <XIcon />
    </Button>
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

interface AddStreamProps {
  showId: string;
  addable: AddableStream[];
}

/**
 * Adds a stream to the end of the lineup, on screen at once if a slot is free: one of the cameras out of it, or a
 * stream going live. A locked camera is listed, but cannot be added until it is unlocked.
 */
const AddStream: FC<AddStreamProps> = ({ showId, addable }) => {
  const organisationId = useOrganisationId();
  const add = useAddToLineup(organisationId, showId);
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="outline" size="sm" className="self-start" />}>
        <PlusIcon />
        Add a stream
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 gap-1.5">
        {addable.length === 0 ? (
          <p className="text-custom-13 text-muted-foreground">
            Every camera is in the lineup, and nobody is going live.
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5" aria-label="Streams to add">
            {addable.map(stream => (
              <li key={stream.streamId}>
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full justify-between"
                  disabled={stream.state === 'locked' || add.isPending}
                  onClick={() => {
                    add.mutate(stream.streamId, { onSuccess: () => setOpen(false) });
                  }}
                >
                  <span className="truncate">{streamLabel(stream)}</span>
                  <StreamStateReason state={stream.state} />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <FormError error={add.error} />
      </PopoverContent>
    </Popover>
  );
};

/** A stream as it is chosen: its code and name, or its name. */
function streamLabel(stream: Pick<LineupStream, 'code' | 'name'>): string {
  return stream.code ? `${stream.code} · ${stream.name}` : stream.name;
}

interface StreamStateReasonProps {
  state: AddableStream['state'];
}

/** What a stream that could be added would be, in a word with its icon: nothing for a camera that is ready. */
const StreamStateReason: FC<StreamStateReasonProps> = ({ state }) => {
  if (state === 'live') {
    return (
      <Reason>
        <BroadcastIcon />
        Live
      </Reason>
    );
  }
  if (state === 'locked') {
    return (
      <Reason>
        <LockIcon />
        Locked
      </Reason>
    );
  }
  if (state === 'disabled') {
    return (
      <Reason>
        <ProhibitIcon />
        Disabled
      </Reason>
    );
  }
  if (state === 'undelivered') {
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
