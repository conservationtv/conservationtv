import { Suspense, type FC } from 'react';
import { CloudSlashIcon, MinusIcon, PlusIcon, StopIcon, VideoCameraIcon } from '@phosphor-icons/react';
import type { CameraCapabilities } from '@conservationtv/cameras';
import { Alert, AlertDescription, AlertTitle } from '@conservationtv/ui/components/alert';
import { Button } from '@conservationtv/ui/components/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@conservationtv/ui/components/empty';
import { Skeleton } from '@conservationtv/ui/components/skeleton';

import { useCameraAbility, useCameraCapabilities } from '@/components/cameras/control/camera-capabilities';
import { useCameraCommand } from '@/components/cameras/control/camera-commands';
import { CameraControlRefusal } from '@/components/cameras/control/camera-control';
import { useCameraControl } from '@/components/cameras/control/camera-control-context';
import { CameraHoldButton } from '@/components/cameras/control/camera-joystick';
import { CameraActionButton, CameraOptionSelect } from '@/components/cameras/control/camera-options';
import { CameraLockNotice } from '@/components/cameras/control/camera-lock';
import { CameraPosition } from '@/components/cameras/control/camera-position';
import { STILL } from '@/components/cameras/control/camera-steering';
import { FormError } from '@/components/common/form-error';

// What a camera's control session has beyond driving it and its presets: what stands in the way of controlling it,
// said where the controls are (`CameraNotices`), and what the camera has to set, to run and to say of itself
// (`CameraSettings`). Both are built from what the camera's agent says the camera can do.

/** How fast a held focus button drives. */
const FOCUS_SPEED = 0.5;

export interface CameraNoticesProps {
  cameraId: string;
}

/**
 * Whatever stands in the way of controlling the camera from here, each as a notice: that it can't be controlled at
 * all and why, that its agent doesn't answer or hasn't heard from it, or that someone else is controlling it. Nothing, taking
 * no room, while nothing does.
 */
export const CameraNotices: FC<CameraNoticesProps> = ({ cameraId }) => {
  const control = useCameraControl();
  return (
    <div className="flex flex-col gap-2 px-3 pt-3 empty:hidden">
      <CameraControlRefusal cameraId={cameraId} />
      {control && (
        <Suspense fallback={null}>
          <AgentNotice />
          <CameraLockNotice />
        </Suspense>
      )}
    </div>
  );
};

/**
 * That the camera's agent couldn't be asked what the camera can do, or that the camera hasn't told it yet: nothing
 * once it has. Suspends until the agent has answered once.
 */
const AgentNotice: FC = () => {
  const ability = useCameraAbility();
  if (ability.status === 'answered') return null;
  if (ability.status === 'unreachable') {
    return (
      <Alert>
        <CloudSlashIcon />
        <AlertTitle>The camera’s agent doesn’t answer</AlertTitle>
        <AlertDescription>{ability.failure} Trying again shortly.</AlertDescription>
      </Alert>
    );
  }
  return (
    <p className="text-custom-13 text-custom-text-secondary">
      Waiting for the camera to tell its agent what it can do. This takes a few seconds after the agent starts.
    </p>
  );
};

/**
 * What the camera has to set and to run, and where it points, built from what it says it can do. Nothing outside a
 * control session (`CameraControl`), so a page sets it down whether or not the camera can be controlled just now.
 */
export const CameraSettings: FC = () => {
  const control = useCameraControl();
  if (!control) return null;
  return (
    <Suspense fallback={<Skeleton className="h-44 w-full" />}>
      <CapableSettings />
    </Suspense>
  );
};

/** Whether there is anything of the camera's to control: a way to move it, something to set, or something to run. */
function controllable(capabilities: CameraCapabilities): boolean {
  return capabilities.moves.length > 0 || capabilities.options.length > 0 || capabilities.actions.length > 0;
}

/**
 * The settings for each thing the camera can do: its options, what it runs and what stops it, and where it points.
 * Until the camera has said what it can do there is only where it points; a camera with nothing to control says so,
 * rather than showing controls that do nothing.
 */
const CapableSettings: FC = () => {
  const capabilities = useCameraCapabilities();
  if (capabilities === null) return <CameraPosition />;
  if (!controllable(capabilities)) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <VideoCameraIcon />
          </EmptyMedia>
          <EmptyTitle>This camera can’t be controlled</EmptyTitle>
          <EmptyDescription>
            It doesn’t move, and has nothing to set: its driver only reads its stream.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  const drives = capabilities.moves.includes('continuous');
  return (
    <div className="flex flex-col gap-6">
      {capabilities.moves.length > 0 && !drives && (
        <p className="text-custom-13 text-custom-text-secondary">
          This camera goes to positions, but can’t be driven by hand: move it with its presets.
        </p>
      )}
      {capabilities.options.length > 0 && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,11rem),1fr))] gap-x-8 gap-y-4">
          {capabilities.options.map(option => (
            <CameraOptionSelect key={option.key} option={option} />
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-start gap-2">
        {capabilities.actions.map(action => (
          <CameraActionButton key={action.name} action={action} />
        ))}
        {drives && capabilities.focus && <CameraFocusButtons />}
        {capabilities.moves.length > 0 && <CameraStopButton />}
      </div>
      <CameraPosition />
    </div>
  );
};

/** The camera's focus, driven nearer or further while a button is held. Driving it takes the camera off autofocus. */
const CameraFocusButtons: FC = () => {
  return (
    <div className="flex touch-none items-center gap-1 select-none">
      <span className="pr-1 text-custom-12 text-custom-text-secondary">Focus</span>
      <CameraHoldButton
        variant="outline"
        size="icon-sm"
        aria-label="Focus nearer while held"
        steering={{ ...STILL, focus: -FOCUS_SPEED }}
      >
        <MinusIcon />
      </CameraHoldButton>
      <CameraHoldButton
        variant="outline"
        size="icon-sm"
        aria-label="Focus further while held"
        steering={{ ...STILL, focus: FOCUS_SPEED }}
      >
        <PlusIcon />
      </CameraHoldButton>
    </div>
  );
};

/** Stops the camera, whoever started it moving and however. */
const CameraStopButton: FC = () => {
  const stop = useCameraCommand();
  return (
    <div className="flex flex-col gap-1">
      <Button variant="outline" size="sm" loading={stop.isPending} onClick={() => stop.mutate({ kind: 'stop' })}>
        <StopIcon weight="fill" />
        Stop
      </Button>
      <FormError error={stop.error} />
    </div>
  );
};
