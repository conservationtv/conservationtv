import { Suspense, useDeferredValue, useEffect, useEffectEvent, useState, type FC } from 'react';
import { useSuspenseQueries } from '@tanstack/react-query';
import { Link } from 'react-router';
import { parseAsString, useQueryState } from 'nuqs';
import { VideoCameraIcon, VideoCameraSlashIcon } from '@phosphor-icons/react';
import type { Camera, Stream } from '@conservationtv/studio-sdk';
import { Button } from '@conservationtv/ui/components/button';
import { ScrollArea } from '@conservationtv/ui/components/scroll-area';
import { Skeleton } from '@conservationtv/ui/components/skeleton';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@conservationtv/ui/components/empty';
import { cn } from '@conservationtv/ui/lib/utils';

import type { Route } from './+types/controls';
import { PinButton } from '@/components/app/pins';
import { CameraDeckPanel, CameraDeckPicture, CameraOperated } from '@/components/cameras/deck/camera-deck';
import { CameraStateBadge } from '@/components/cameras/camera-state-badge';
import { createShoulderStore } from '@/components/cameras/control/drive/camera-shoulders';
import { BackLink } from '@/components/common/page';
import { CTVMoQPreview } from '@/components/streams/ctv-moq-preview';
import { useOrganisationId } from '@/hooks/use-organisation';
import { cameraListQueryOptions } from '@/queries/cameras';
import { streamListQueryOptions } from '@/queries/streams';

export const meta: Route.MetaFunction = () => [{ title: 'Controls · conservation.tv studio' }];

// The organisation's cameras, to operate rather than to read about: one camera's picture as large as the window
// allows, with what drives it and its presets beneath, and beside it every camera, live, to swap to. The page is one
// place, whichever camera is on it: the camera is named in its address (`?camera=`), so swapping changes what is on
// screen without leaving, and a camera can still be linked to. It lies over the app's own chrome, which is still
// underneath: Back returns to the organisation.
//
// Swapping is not allowed to blank the page. The camera chosen is marked at once, but what is on screen follows a
// moment behind it (`useDeferredValue`): the last camera's picture and controls stay, dimmed, until the next one's
// control session has been asked for, and only then give way. That works because the boundary around the deck stays
// where it is from one camera to the next; a boundary that came and went with each camera would show its fallback.

/** How many cameras have a number key of their own: 1 to 9, in the order they are listed. */
const NUMBERED = 9;

/** What a camera is called, or a stand-in for one whose device can't be read. */
const nameOf = (camera: Camera) => camera.device?.name ?? 'Unnamed camera';

/** Whether a key press is being typed into something, and so isn't a shortcut. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/** The camera a step before (-1) or after (1) the one on screen, going round at the ends. */
function cameraBeside(step: number, cameras: Camera[], current: Camera | undefined): Camera | undefined {
  if (step === 0 || cameras.length === 0) return undefined;
  const index = current ? cameras.indexOf(current) : 0;
  return cameras[(index + step + cameras.length) % cameras.length];
}

/** The camera a key asks for: its number, or the one before or after the one on screen with `[` and `]`. */
function cameraForKey(key: string, cameras: Camera[], current: Camera | undefined): Camera | undefined {
  if (/^[1-9]$/.test(key)) return cameras[Number(key) - 1];
  const step = key === ']' ? 1 : key === '[' ? -1 : 0;
  return cameraBeside(step, cameras, current);
}

const ControlsRoute: FC = () => {
  const organisationId = useOrganisationId();
  const [camerasQuery, streamsQuery] = useSuspenseQueries({
    queries: [cameraListQueryOptions(organisationId), streamListQueryOptions(organisationId)]
  });
  const cameras = camerasQuery.data;
  const streams = streamsQuery.data;
  const [selected, setSelected] = useQueryState('camera', parseAsString);
  // The camera the address names; without one, or with one that has gone, the first that is switched on.
  const camera =
    cameras.find(candidate => candidate.id === selected) ??
    cameras.find(candidate => candidate.state === 'enabled') ??
    cameras[0];
  // What is on screen: the chosen camera, once its deck is ready to show. Until then, the one before it.
  const shown = useDeferredValue(camera);
  const swapping = shown?.id !== camera?.id;
  const streamOf = (id: string) => streams.find(candidate => candidate.sourceDeviceId === id);
  const choose = (next: Camera) => void setSelected(next.id);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // A bare key, outside any field: with a modifier it is the browser's, and in a field it is text.
      if (event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;
      const next = cameraForKey(event.key, cameras, camera);
      if (next && next.id !== camera?.id) void setSelected(next.id);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cameras, camera, setSelected]);

  // A gamepad's shoulder buttons step between cameras as `[` and `]` do: L1 to the one before, R1 to the one after.
  // Which press is a press is the shoulder store's (camera-shoulders.ts); it lives here, above every camera's control
  // session, so a button still held as the next camera comes on screen is not a second press.
  const [shoulders] = useState(() => createShoulderStore());
  const step = useEffectEvent((by: number) => {
    const next = cameraBeside(by, cameras, camera);
    if (next && next.id !== camera?.id) void setSelected(next.id);
  });
  useEffect(() => {
    const stepping = shoulders.on('stepped', event => step(event.by));
    shoulders.trigger.started();
    return () => {
      shoulders.trigger.stopped();
      stepping.unsubscribe();
    };
  }, [shoulders]);

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-background">
      <header className="flex shrink-0 items-center justify-between px-5 pt-4 pb-3">
        <BackLink className="mb-0" to=".." relative="path">
          Back
        </BackLink>
        <PinButton label="Controls" kind="camera" />
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-4 px-5 pb-5 lg:flex-row">
        {shown ? (
          <div
            aria-busy={swapping}
            className={cn(
              'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card transition-opacity',
              swapping && 'opacity-60'
            )}
          >
            {/* This boundary stays from one camera to the next: its fallback is only ever the page's first load. */}
            <Suspense fallback={<Skeleton className="size-full rounded-none" />}>
              {/* Keyed by the camera: a control session is one camera's. */}
              <CameraOperated key={shown.id} cameraId={shown.id}>
                {/* The picture takes whatever the panel leaves: as large as fits that space at 16:9, in its middle. */}
                <div className="flex min-h-40 flex-1 items-center justify-center bg-neutral-900 [container-type:size]">
                  <div className="w-[min(100cqw,calc(100cqh*16/9))]">
                    <CameraDeckPicture name={nameOf(shown)} stream={streamOf(shown.id)} />
                  </div>
                </div>
                <div className="shrink-0">
                  <CameraDeckPanel camera={shown} />
                </div>
              </CameraOperated>
            </Suspense>
          </div>
        ) : (
          <Empty className="min-w-0 flex-1 border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <VideoCameraIcon />
              </EmptyMedia>
              <EmptyTitle>No cameras yet</EmptyTitle>
              <EmptyDescription>Add a camera to the organisation, and it can be operated from here.</EmptyDescription>
            </EmptyHeader>
            <Button nativeButton={false} render={<Link to="../cameras/new" relative="path" />}>
              Add a camera
            </Button>
          </Empty>
        )}
        {cameras.length > 0 && (
          <aside className="flex max-h-44 w-full shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-card lg:max-h-none lg:w-64">
            <h2 className="flex shrink-0 items-baseline justify-between px-3 pt-3 pb-2 text-custom-12 text-custom-text-secondary">
              <span>Cameras</span>
              <span>1–9, [ ] or L1 R1 to swap</span>
            </h2>
            <ScrollArea className="min-h-0 flex-1">
              <ul className="flex w-max gap-2 px-2 pb-2 lg:w-auto lg:flex-col">
                {cameras.map((candidate, index) => (
                  <li key={candidate.id} className="w-48 shrink-0 lg:w-auto">
                    <CameraChoice
                      camera={candidate}
                      stream={streamOf(candidate.id)}
                      number={index < NUMBERED ? index + 1 : undefined}
                      chosen={candidate.id === camera?.id}
                      onScreen={candidate.id === shown?.id}
                      onChoose={choose}
                    />
                  </li>
                ))}
              </ul>
            </ScrollArea>
          </aside>
        )}
      </div>
    </div>
  );
};

export default ControlsRoute;

interface CameraChoiceProps {
  camera: Camera;
  /** The stream its picture is played from, if it feeds one. */
  stream: Stream | undefined;
  /** Its number key, for the first nine. */
  number: number | undefined;
  /** Whether it is the camera chosen: marked at once, before its deck is on screen. */
  chosen: boolean;
  /** Whether its picture is the large one now, and so isn't played here a second time. */
  onScreen: boolean;
  onChoose: (camera: Camera) => void;
}

/**
 * One camera to swap to: its picture, live, with its name and number key over it. The camera on screen is marked
 * instead of played a second time, since its picture is already the large one.
 */
const CameraChoice: FC<CameraChoiceProps> = ({ camera, stream, number, chosen, onScreen, onChoose }) => {
  return (
    <button
      type="button"
      aria-pressed={chosen}
      onClick={() => onChoose(camera)}
      className={cn(
        'group relative block w-full overflow-hidden rounded-lg bg-neutral-900 text-left outline-none',
        'ring-2 ring-transparent focus-visible:ring-ring',
        chosen ? 'ring-foreground' : 'hover:ring-border'
      )}
    >
      {/* The picture takes no clicks of its own: the whole tile is the button. */}
      <div className="pointer-events-none aspect-video *:rounded-none">
        {stream && !onScreen ? (
          <CTVMoQPreview stream={stream.id} />
        ) : (
          <div className="flex aspect-video items-center justify-center text-custom-12 text-white/60">
            {onScreen ? 'On screen' : <VideoCameraSlashIcon className="size-5" aria-label="No picture" />}
          </div>
        )}
      </div>
      <div className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-linear-to-t from-black/70 to-transparent px-2 pt-5 pb-1.5 text-custom-12 text-white">
        {number !== undefined && (
          <span className="flex size-4 shrink-0 items-center justify-center rounded-sm bg-white/20 tabular-nums">
            {number}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate font-medium">{nameOf(camera)}</span>
        {camera.state !== 'enabled' && <CameraStateBadge state={camera.state} />}
      </div>
    </button>
  );
};
