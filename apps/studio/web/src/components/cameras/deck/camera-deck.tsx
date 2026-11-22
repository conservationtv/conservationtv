import { Suspense, useState, type FC, type ReactNode } from 'react';
import { JoystickIcon, SlidersHorizontalIcon } from '@phosphor-icons/react';
import type { Camera, Stream } from '@conservationtv/studio-sdk';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@conservationtv/ui/components/empty';
import { Skeleton } from '@conservationtv/ui/components/skeleton';
import { Tabs, TabsContent } from '@conservationtv/ui/components/tabs';
import { cn } from '@conservationtv/ui/lib/utils';

import {
  PresetGrid,
  PresetMenu,
  PresetNotice,
  PresetPicture,
  PresetTile
} from '@/components/cameras/deck/camera-presets';
import { CameraControl } from '@/components/cameras/control/camera-control';
import { useCameraControl } from '@/components/cameras/control/camera-control-context';
import { CameraNotices, CameraSettings } from '@/components/cameras/control/parts/settings/camera-controls';
import { CameraJoystick } from '@/components/cameras/control/parts/camera-joystick';
import {
  PresetGo,
  PresetOverwrite,
  PresetOverwriteItem,
  SavePresetDialog
} from '@/components/cameras/control/parts/camera-preset-controls';
import { CameraSurface, CameraSurfaceTitle } from '@/components/cameras/control/parts/camera-surface';
import { PageTabsActions, PageTabsBar, PageTabsList, PageTabsTrigger } from '@/components/common/page-tabs';
import { CTVMoQPreview } from '@/components/streams/ctv-moq-preview';
import { useIsAdministrator } from '@/hooks/use-organisation';

// A camera's deck: its picture and, in the same card, what is done with it. The camera's own page sets it down among
// what else there is to know of the camera; the control view (src/routes/controls.tsx) gives it the whole screen.

interface CameraOperationProps {
  cameraId: string;
  /** The camera's picture and controls. They render whether or not the camera is controlled here. */
  children: ReactNode;
}

/**
 * An administrator's page controls the camera for as long as it is open: what moves the camera comes with the
 * control session, and is absent, with why, while the camera can't be controlled. Anyone else has its picture and
 * its presets to look at.
 */
export const CameraOperation: FC<CameraOperationProps> = ({ cameraId, children }) => {
  return (
    <Suspense fallback={<Skeleton className="aspect-video w-full rounded-xl" />}>
      <CameraOperated cameraId={cameraId}>{children}</CameraOperated>
    </Suspense>
  );
};

/**
 * `CameraOperation` without a boundary of its own: it suspends, until the studio has answered for the camera, into
 * whichever boundary the page puts around it. A page that swaps between cameras keeps that boundary in place from one
 * camera to the next, so the camera on screen stays there while the next one's session is asked for.
 */
export const CameraOperated: FC<CameraOperationProps> = ({ cameraId, children }) => {
  const administrator = useIsAdministrator();
  if (!administrator) return children;
  return <CameraControl cameraId={cameraId}>{children}</CameraControl>;
};

/** The tabs under the camera's picture. */
type DeckTab = 'controls' | 'camera';

interface CameraDeckProps {
  camera: Camera;
  /** What the camera is called, shown over its picture. */
  name: string;
  /** The stream the picture is played from: the first the camera feeds, if it feeds any. */
  stream: Stream | undefined;
}

/**
 * The camera's picture and, beneath it in one card, what is done with the camera: the deck as the camera's own page
 * sets it down, as wide as the page. A view that sizes the picture itself composes `CameraDeckPicture` and
 * `CameraDeckPanel` in a card of its own.
 */
export const CameraDeck: FC<CameraDeckProps> = ({ camera, name, stream }) => {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <CameraDeckPicture name={name} stream={stream} />
      <CameraDeckPanel camera={camera} />
    </div>
  );
};

interface CameraDeckPictureProps {
  /** What the camera is called, shown over its picture. */
  name: string;
  /** The stream the picture is played from: the first the camera feeds, if it feeds any. */
  stream: Stream | undefined;
}

/**
 * The camera's picture, at 16:9 across whatever holds it, with its name over it, steered on while the camera is
 * controlled here.
 */
export const CameraDeckPicture: FC<CameraDeckPictureProps> = ({ name, stream }) => {
  return (
    <CameraSurface>
      {/* The video's own corners are squared off: whatever holds it rounds them, and the panel meets its foot. */}
      <div className="*:rounded-none">
        {stream ? (
          <CTVMoQPreview stream={stream.id} />
        ) : (
          <div className="flex aspect-video w-full items-center justify-center bg-muted px-6 text-center text-custom-13 text-muted-foreground">
            This camera feeds no stream yet, so there’s no picture.
          </div>
        )}
      </div>
      <CameraSurfaceTitle>{name}</CameraSurfaceTitle>
    </CameraSurface>
  );
};

interface CameraDeckPanelProps {
  camera: Camera;
}

/**
 * What is done with the camera, under its picture. Under Controls, what drives it by hand beside its presets; under
 * Camera, what it has to set and to run, and where it points. What moves the camera is the control layer's, which
 * sets down nothing outside a control session: then the panel is the presets, to look at. Why the camera can't be
 * controlled, when it can't, is said under the tabs, whichever is open.
 */
export const CameraDeckPanel: FC<CameraDeckPanelProps> = ({ camera }) => {
  const administrator = useIsAdministrator();
  const control = useCameraControl();
  const [tab, setTab] = useState<DeckTab>('controls');
  return (
    // The Camera tab goes with the control session: if the session ends while it is open, Controls is shown.
    <Tabs
      value={control ? tab : 'controls'}
      onValueChange={next => setTab(next === 'camera' ? 'camera' : 'controls')}
      className="gap-0"
    >
      <PageTabsBar className="px-3 pt-1.5">
        <PageTabsList>
          <PageTabsTrigger value="controls">
            <JoystickIcon />
            Controls
          </PageTabsTrigger>
          {control && (
            <PageTabsTrigger value="camera">
              <SlidersHorizontalIcon />
              Camera
            </PageTabsTrigger>
          )}
        </PageTabsList>
        <PageTabsActions>
          <SavePresetDialog />
        </PageTabsActions>
      </PageTabsBar>
      {administrator && <CameraNotices cameraId={camera.id} />}
      <TabsContent value="controls">
        <div className="flex flex-col sm:flex-row">
          <CameraJoystick />
          <CameraPresets camera={camera} />
        </div>
        <PresetNotice cameraId={camera.id} />
      </TabsContent>
      {control && (
        <TabsContent value="camera" className="flex flex-col gap-4 p-4">
          <p className="max-w-2xl text-custom-13 text-custom-text-secondary">
            Moved through the active agent on its network, straight from this browser. Whoever moved it last holds it
            for a moment: chat commands wait for someone at these controls.
          </p>
          <CameraSettings />
        </TabsContent>
      )}
    </Tabs>
  );
};

/** How tall the presets are, with any or none: two rows of tiles and the space around them. */
const PRESETS_HEIGHT = 'h-40';

interface CameraPresetsProps {
  camera: Camera;
}

/**
 * The camera's presets, oldest first, as tiles. In a control session a tile points the camera at its preset; an
 * administrator's has a menu to rename it, set it to where the camera points now, remove its picture, or delete it.
 */
const CameraPresets: FC<CameraPresetsProps> = ({ camera }) => {
  const administrator = useIsAdministrator();
  if (camera.presets.length === 0) {
    return (
      // The same height as two rows of tiles, so the panel doesn't jump when the first preset is saved, or between
      // a camera with presets and one without.
      <Empty className={cn(PRESETS_HEIGHT, 'min-w-0 flex-1 justify-center gap-1 p-3')}>
        <EmptyHeader className="gap-1">
          <EmptyTitle className="text-custom-13">No presets yet</EmptyTitle>
          <EmptyDescription className="text-custom-12">
            {administrator
              ? 'Point the camera somewhere worth coming back to, then save the position under a name.'
              : 'An administrator saves them, from where the camera points.'}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <PresetGrid className={cn(PRESETS_HEIGHT, 'min-w-0 flex-1')}>
      {camera.presets.map(preset => (
        <PresetTile key={preset.id} preset={preset}>
          <PresetPicture cameraId={camera.id} preset={preset} />
          <PresetGo preset={preset} />
          {administrator && (
            <PresetOverwrite preset={preset}>
              <PresetMenu cameraId={camera.id} preset={preset}>
                <PresetOverwriteItem />
              </PresetMenu>
            </PresetOverwrite>
          )}
        </PresetTile>
      ))}
    </PresetGrid>
  );
};
