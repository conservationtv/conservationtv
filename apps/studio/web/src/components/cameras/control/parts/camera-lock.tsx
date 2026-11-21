import { Suspense, type FC } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { LockIcon } from '@phosphor-icons/react';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@conservationtv/ui/components/alert';
import { Button, type ButtonProps } from '@conservationtv/ui/components/button';

import { useCameraLock } from '@/components/cameras/control/camera-control-context';
import { useCameraStore } from '@/components/cameras/control/store/camera-store';
import { useOrganisationId } from '@/hooks/use-organisation';
import { shortPublicId } from '@/lib/format';
import { deviceListQueryOptions } from '@/queries/devices';

// The lock on a camera someone else is controlling, where the controls are. A camera is held by whoever last moved
// it, for a little while after; while that is another device, this browser sends the camera nothing (camera-store.ts),
// and these parts say who has it and offer to take it over. For parts under a control session.

export interface HolderNameProps {
  /** The public ID of the device holding the camera. */
  peer: string;
}

/**
 * Who a device at the camera's controls is: the member whose browser it is, by what the organisation calls them; an
 * agent, by its name; and otherwise its public ID, shortened. Suspends until the organisation's devices are read.
 */
export const HolderName: FC<HolderNameProps> = ({ peer }) => {
  const organisationId = useOrganisationId();
  const nameQuery = useSuspenseQuery({
    ...deviceListQueryOptions(organisationId),
    select: devices => {
      // A browser is named for its member, never for itself: what it is called is only what kind of browser it is.
      const device = devices.find(candidate => candidate.publicId === peer);
      if (device === undefined) return shortPublicId(peer);
      if (device.kind === 'browser') return device.memberName ?? 'Another member';
      return device.name;
    }
  });
  return nameQuery.data;
};

/** Who has the camera, as a few words: "James is controlling". */
const LockedBy: FC<HolderNameProps> = ({ peer }) => {
  return (
    <>
      <Suspense fallback="Someone else">
        <HolderName peer={peer} />
      </Suspense>{' '}
      is controlling
    </>
  );
};

interface TakeControlButtonProps extends ButtonProps {
  /** The device the camera is taken over from. */
  peer: string;
}

/** Takes the camera over from whoever has it: the controls here work again, and the next thing they do moves it. */
const TakeControlButton: FC<TakeControlButtonProps> = ({ peer, ...props }) => {
  const store = useCameraStore();
  return (
    <Button size="sm" onClick={() => store.trigger.tookOver({ peer })} {...props}>
      Take control
    </Button>
  );
};

/**
 * Says who is controlling the camera, while it is locked by them, and offers to take it over. Nothing while the
 * camera is free to move from here.
 */
export const CameraLockNotice: FC = () => {
  const peer = useCameraLock();
  if (peer === null) return null;
  return (
    <Alert>
      <LockIcon />
      <AlertTitle>
        <LockedBy peer={peer} />
      </AlertTitle>
      <AlertDescription>
        These controls are locked while they are, and free again a few seconds after they stop. Taking control moves the
        camera out from under them.
      </AlertDescription>
      <AlertAction>
        <TakeControlButton peer={peer} variant="outline" />
      </AlertAction>
    </Alert>
  );
};

/**
 * The same, over the camera's picture, in place of what moves the camera on it: who is controlling it, and the way
 * to take it over. Nothing while the camera is free to move from here.
 */
export const CameraLockOverlay: FC = () => {
  const peer = useCameraLock();
  if (peer === null) return null;
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/35">
      <div className="flex items-center gap-3 rounded-full bg-black/70 py-1.5 pr-1.5 pl-4 text-custom-14 font-semibold text-white backdrop-blur-sm">
        <LockIcon weight="fill" className="size-4 shrink-0" />
        <span>
          <LockedBy peer={peer} />
        </span>
        <TakeControlButton peer={peer} variant="secondary" className="rounded-full" />
      </div>
    </div>
  );
};
