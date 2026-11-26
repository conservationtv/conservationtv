import { useState, type FC, type KeyboardEvent, type PointerEvent } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { WarningIcon } from '@phosphor-icons/react';
import { LAYOUTS, layoutOf } from '@conservationtv/shows';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@conservationtv/ui/components/select';
import { cn } from '@conservationtv/ui/lib/utils';

import { FormError } from '@/components/common/form-error';
import { LayoutCell, LayoutGrid, type LayoutCellProps } from '@/components/shows/layout-grid';
import { unreachingOutputsOf } from '@/components/shows/unreachable';
import { useOrganisationId } from '@/hooks/use-organisation';
import { showQueryOptions, useSwapLineup, useUpdateShowControls, type LineupStream } from '@/queries/shows';

// A show's layout, as its controls operate it: how many slots it has, and what is in each. Both are drawn from the
// layout table in packages/shows, which the broadcast is composed from.

export interface ShowLayoutProps {
  showId: string;
}

/** Chooses the show's layout, from none to six slots, each drawn as it is laid out. Any member. */
export const ShowLayoutPicker: FC<ShowLayoutProps> = ({ showId }) => {
  const organisationId = useOrganisationId();
  const update = useUpdateShowControls(organisationId, showId);
  const slotsQuery = useSuspenseQuery({ ...showQueryOptions(organisationId, showId), select: show => show.slots });
  const slots = slotsQuery.data;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span id={`${showId}-layout`} className="text-custom-13 text-muted-foreground">
          Layout
        </span>
        <Select<number>
          value={slots}
          onValueChange={value => {
            if (value !== null && value !== slots) update.mutate({ slots: value });
          }}
        >
          <SelectTrigger size="sm" aria-labelledby={`${showId}-layout`} className="border-transparent bg-transparent">
            <SelectValue>{(value: number) => layoutName(value)}</SelectValue>
          </SelectTrigger>
          <SelectContent align="end" alignItemWithTrigger={false} className="w-auto">
            {LAYOUTS.map((rects, count) => (
              <SelectItem key={count} value={count}>
                <LayoutGrid className="w-10 gap-px rounded-[2px] bg-border p-px">
                  {rects.map(rect => (
                    <LayoutCell key={rect.join()} rect={rect} className="rounded-[1px] bg-popover" />
                  ))}
                </LayoutGrid>
                {layoutName(count)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <FormError error={update.error} />
    </div>
  );
};

/** What a layout is called, by its slot count: "6 cam", or "No cameras" for none. */
function layoutName(slots: number): string {
  return slots === 0 ? 'No cameras' : `${String(slots)} cam`;
}

/** A stream being dragged by a pointer: which, how far it has moved, and onto which stream it would drop. */
interface Drag {
  streamId: string;
  pointerId: number;
  /** Whether a finger made it: a touch only ever presses, so the page still scrolls under it. */
  touch: boolean;
  startX: number;
  startY: number;
  dx: number;
  dy: number;
  /** Whether it has moved far enough to be a drag rather than a press. */
  moving: boolean;
  over: string | null;
}

/** How far a press moves before it is a drag, in CSS pixels. */
const DRAG_THRESHOLD = 4;

/**
 * The layout as it is on screen, each slot showing its stream's code (or name): drag one onto another to swap them
 * (with a mouse or pen), or press one and then another (by any pointer, a finger included, or by keyboard with Enter
 * or Space; Escape lets go). A drop on an empty slot does nothing. Swaps name streams, never positions, and show at
 * once. On a phone the map fills the column, so a finger is left to scroll the page rather than drag.
 */
export const ShowLayoutMap: FC<ShowLayoutProps> = ({ showId }) => {
  const organisationId = useOrganisationId();
  const swap = useSwapLineup(organisationId, showId);
  const showQuery = useSuspenseQuery(showQueryOptions(organisationId, showId));
  const show = showQuery.data;
  const { slots, lineup } = show;
  const [picked, setPicked] = useState<string | null>(null);
  const [following, setDrag] = useState<Drag | null>(null);
  const rects = layoutOf(slots);
  const at = (position: number) => lineup.find(stream => stream.position === position);
  // A drag whose stream has left the screen (another member swapped it off, the layout shrank) is over.
  const onScreen = rects.some((_rect, index) => at(index + 1)?.streamId === following?.streamId);
  const drag = onScreen ? following : null;
  const pickedStream = lineup.find(stream => stream.streamId === picked);

  /** A press on a slot: picks its stream, lets it go, or swaps it with the one picked. */
  const press = (stream: LineupStream | undefined) => {
    if (!stream || picked === stream.streamId) return setPicked(null);
    if (picked === null) return setPicked(stream.streamId);
    swap.mutate({ a: picked, b: stream.streamId });
    setPicked(null);
  };

  /** A pointer let go of a slot: a press if it never moved, else a drop on whatever stream it is over. */
  const release = (event: PointerEvent<HTMLElement>, stream: LineupStream | undefined) => {
    const ended = endDrag(event, drag, setDrag);
    if (ended === 'press') return press(stream);
    if (ended?.over) swap.mutate({ a: ended.streamId, b: ended.over });
  };

  if (rects.length === 0) {
    return (
      <LayoutGrid className="place-items-center rounded-lg border border-dashed text-custom-13 text-muted-foreground">
        <span className="col-span-full row-span-full">No cameras on screen</span>
      </LayoutGrid>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <LayoutGrid
        className="gap-1.5"
        role="group"
        aria-label="What is on screen, by slot"
        aria-describedby={`${showId}-slots-help`}
      >
        {rects.map((rect, index) => {
          const stream = at(index + 1);
          return (
            <MapSlot
              key={rect.join()}
              rect={rect}
              position={index + 1}
              stream={stream}
              unreaching={stream ? unreachingOutputsOf(show, stream.streamId).map(output => output.name) : []}
              aria-pressed={picked !== null && picked === stream?.streamId}
              {...slotMarks(stream, picked, drag)}
              style={dragOffset(stream, drag)}
              onPointerDown={event => startDrag(event, stream, setDrag)}
              onPointerMove={event => moveDrag(event, drag, setDrag)}
              onPointerUp={event => release(event, stream)}
              onPointerCancel={() => setDrag(null)}
              // After a pointer is let go too, by when the drag is already over.
              onLostPointerCapture={() => setDrag(null)}
              onKeyDown={event =>
                keyed(
                  event,
                  () => press(stream),
                  () => setPicked(null)
                )
              }
            />
          );
        })}
      </LayoutGrid>
      <p id={`${showId}-slots-help`} className="sr-only" aria-live="polite">
        {pickedStream
          ? `${pickedStream.name} picked: choose another slot to swap it with, or press Escape.`
          : 'Drag a slot onto another to swap them, or press one and then another.'}
      </p>
      <FormError error={swap.error} />
    </div>
  );
};

interface MapSlotProps extends LayoutCellProps {
  /** Its position in the lineup, from 1. */
  position: number;
  /** The stream in it, or none for an empty slot. */
  stream: LineupStream | undefined;
  /** The outputs following the show that cannot reach its stream, by name: the lineup below says why. */
  unreaching: string[];
}

/**
 * One slot of the map: its stream's code (or name), or empty, marked when an output cannot reach it. Styled by its
 * marks: `data-picked`, `data-dragging`, `data-target` (what a drag would drop on) and `data-empty`.
 */
const MapSlot: FC<MapSlotProps> = ({ position, stream, unreaching, className, ...props }) => {
  return (
    <LayoutCell
      role="button"
      tabIndex={0}
      aria-label={slotLabel(position, stream, unreaching)}
      data-slot-stream={stream?.streamId}
      data-empty={stream ? undefined : ''}
      className={cn(
        'flex min-w-0 cursor-grab items-center justify-center gap-1 overflow-hidden rounded-md bg-muted px-1 text-custom-13 font-semibold text-muted-foreground outline-none select-none focus-visible:ring-2 focus-visible:ring-ring',
        'data-empty:cursor-default data-empty:border data-empty:border-dashed data-empty:bg-transparent data-empty:font-normal',
        'data-picked:ring-2 data-picked:ring-primary data-target:ring-2 data-target:ring-primary/60',
        'data-dragging:z-10 data-dragging:cursor-grabbing data-dragging:opacity-90 data-dragging:shadow-lg',
        className
      )}
      {...props}
    >
      {unreaching.length > 0 && <WarningIcon aria-hidden className="size-3.5 shrink-0 text-custom-warning" />}
      <span className="truncate">{stream ? (stream.code ?? stream.name) : 'Empty'}</span>
    </LayoutCell>
  );
};

/**
 * The marks a slot is styled by: whether its stream is picked, is being dragged, or is what the drag would drop on.
 * Only a drag that has moved past the threshold marks anything, and a slot is never its own drag's target.
 */
function slotMarks(stream: LineupStream | undefined, picked: string | null, drag: Drag | null) {
  const streamId = stream?.streamId;
  const moving = drag?.moving === true && streamId !== undefined;
  const dragging = moving && drag.streamId === streamId;
  return {
    'data-picked': mark(streamId !== undefined && picked === streamId),
    'data-dragging': mark(dragging),
    'data-target': mark(moving && !dragging && drag.over === streamId)
  };
}

/** A data attribute that is there or not. */
function mark(on: boolean): '' | undefined {
  return on ? '' : undefined;
}

/** Where the dragged slot has been moved to, following the pointer; nothing for any other slot. */
function dragOffset(stream: LineupStream | undefined, drag: Drag | null) {
  if (!drag?.moving || drag.streamId !== stream?.streamId) return undefined;
  return { transform: `translate(${String(drag.dx)}px, ${String(drag.dy)}px)` };
}

/**
 * What a slot is, to assistive technology: its position, its stream or that it is empty, and the outputs that cannot
 * reach its stream, as the warning icon says it to the eye.
 */
function slotLabel(position: number, stream: LineupStream | undefined, unreaching: readonly string[]): string {
  const label = `Slot ${String(position)}: ${stream ? stream.name : 'empty'}`;
  return unreaching.length === 0 ? label : `${label}; ${unreaching.join(', ')} cannot reach it`;
}

/** Enter or Space presses a slot; Escape lets go of the one picked. */
function keyed(event: KeyboardEvent, press: () => void, cancel: () => void) {
  if (event.key === 'Escape') return cancel();
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  press();
}

/** Starts following a primary press on a slot with a stream in it; an empty slot can't be dragged. */
function startDrag(event: PointerEvent<HTMLElement>, stream: LineupStream | undefined, setDrag: (drag: Drag) => void) {
  if (!event.isPrimary || event.button !== 0 || !stream) return;
  const touch = event.pointerType === 'touch';
  if (!touch) event.currentTarget.setPointerCapture(event.pointerId);
  setDrag({
    streamId: stream.streamId,
    pointerId: event.pointerId,
    touch,
    startX: event.clientX,
    startY: event.clientY,
    dx: 0,
    dy: 0,
    moving: false,
    over: null
  });
}

/**
 * Moves the dragged slot with the pointer, once it has gone far enough, and notes the stream beneath it. A finger that
 * goes as far is scrolling the page, and is no longer a press.
 */
function moveDrag(event: PointerEvent<HTMLElement>, drag: Drag | null, setDrag: (drag: Drag | null) => void) {
  if (drag?.pointerId !== event.pointerId) return;
  const dx = event.clientX - drag.startX;
  const dy = event.clientY - drag.startY;
  const far = Math.hypot(dx, dy) > DRAG_THRESHOLD;
  if (drag.touch) {
    if (far) setDrag(null);
    return;
  }
  const moving = drag.moving || far;
  setDrag({ ...drag, dx, dy, moving, over: moving ? streamBeneath(event, drag.streamId) : null });
}

/**
 * Ends a drag: `'press'` if it never moved far enough to be one, the drag (with the stream it was dropped on, if any)
 * if it did, or null if this pointer wasn't dragging.
 */
function endDrag(event: PointerEvent<HTMLElement>, drag: Drag | null, setDrag: (drag: null) => void) {
  if (drag?.pointerId !== event.pointerId) return null;
  setDrag(null);
  if (!drag.moving) return 'press' as const;
  return { ...drag, over: streamBeneath(event, drag.streamId) };
}

/** The stream in the slot under the pointer, other than the one being dragged (which moves with it). */
function streamBeneath(event: PointerEvent<HTMLElement>, dragged: string): string | null {
  for (const element of document.elementsFromPoint(event.clientX, event.clientY)) {
    const slot = element.closest<HTMLElement>('[data-slot-stream]');
    const streamId = slot?.dataset.slotStream;
    if (streamId && streamId !== dragged) return streamId;
  }
  return null;
}
