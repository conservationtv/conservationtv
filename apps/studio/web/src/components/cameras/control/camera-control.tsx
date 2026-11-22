import { useEffect, useState, type FC, type ReactNode } from 'react';
import { useSuspenseQuery } from '@tanstack/react-query';
import { CloudSlashIcon, LockIcon, VideoCameraSlashIcon } from '@phosphor-icons/react';
import type { CameraCommand } from '@conservationtv/cameras';
import { Alert, AlertDescription, AlertTitle } from '@conservationtv/ui/components/alert';

import { CameraControlContext } from '@/components/cameras/control/camera-control-context';
import { CameraDriving } from '@/components/cameras/control/drive/camera-drive';
import { CameraFollowing } from '@/components/cameras/control/following/camera-live';
import { CameraPicture } from '@/components/cameras/control/picture/camera-picture';
import { createCameraStore, CameraStoreContext, runCommand } from '@/components/cameras/control/store/camera-store';
import { cameraListenerOf } from '@/components/cameras/control/following/camera-stream';
import { useOrganisationId } from '@/hooks/use-organisation';
import { cameraControlQueryOptions, runCameraCommand, type CameraControlSession } from '@/queries/camera-control';

export interface CameraControlProps {
  cameraId: string;
  /** The page's parts, some of which control the camera. They render whether or not it can be controlled. */
  children: ReactNode;
}

/**
 * Controls a camera for as long as it is rendered: asks the studio for who reaches the camera and a grant to control
 * it, and keeps the grant fresh. With one, the parts beneath are in a control session (`CameraSession`); while the
 * camera can't be controlled there is none, and the parts that need one render nothing, with `CameraControlRefusal`
 * saying why. Suspends until the studio has answered.
 */
export const CameraControl: FC<CameraControlProps> = ({ cameraId, children }) => {
  const organisationId = useOrganisationId();
  const answerQuery = useSuspenseQuery(cameraControlQueryOptions(organisationId, cameraId));
  const answer = answerQuery.data;
  if (answer.status === 'refused') return children;
  // A session is for one camera: another is another session, with a store of its own.
  return (
    <CameraSession key={`${organisationId}/${cameraId}`} cameraId={cameraId} session={answer.session}>
      {children}
    </CameraSession>
  );
};

interface CameraSessionProps extends CameraControlProps {
  session: CameraControlSession;
}

/**
 * A control session: what is known of the camera (its store), following it through its agent, sending it commands,
 * driving it where the parts beneath steer it, and letting them take a still of its picture. A renewed grant keeps
 * the same session and store going: the store is told, and what is sent from then on goes through it.
 */
const CameraSession: FC<CameraSessionProps> = ({ cameraId, session, children }) => {
  const organisationId = useOrganisationId();
  const [store] = useState(() =>
    createCameraStore({
      session,
      agent: {
        send: (granted, command) => runCameraCommand(organisationId, cameraId, granted, command),
        listen: cameraListenerOf(organisationId, cameraId)
      }
    })
  );
  useEffect(() => store.trigger.renewed({ session }), [store, session]);
  // Gating, claiming and sending are all the store's `commanded`: this only hands parts a promise of how it went.
  const run = (command: CameraCommand) => runCommand(store, command);
  return (
    <CameraControlContext value={{ cameraId, session, run }}>
      <CameraStoreContext value={store}>
        <CameraFollowing />
        <CameraPicture>
          <CameraDriving>{children}</CameraDriving>
        </CameraPicture>
      </CameraStoreContext>
    </CameraControlContext>
  );
};

export interface CameraControlRefusalProps {
  cameraId: string;
}

/**
 * Why the camera can't be controlled from here, in place of its controls: nothing while it can. It reads the same
 * answer `CameraControl` does, from the query cache.
 */
export const CameraControlRefusal: FC<CameraControlRefusalProps> = ({ cameraId }) => {
  const organisationId = useOrganisationId();
  const answerQuery = useSuspenseQuery(cameraControlQueryOptions(organisationId, cameraId));
  const answer = answerQuery.data;
  if (answer.status === 'granted') return null;
  if (answer.reason === 'forbidden') {
    return (
      <Alert>
        <LockIcon />
        <AlertTitle>Only administrators control cameras</AlertTitle>
        <AlertDescription>
          Ask one of this organisation’s administrators to move it, or to make you one.
        </AlertDescription>
      </Alert>
    );
  }
  if (answer.reason === 'unavailable') {
    return (
      <Alert>
        <VideoCameraSlashIcon />
        <AlertTitle>This camera can’t be controlled right now</AlertTitle>
        <AlertDescription>
          It isn’t enabled, or its network has no active agent to reach it through. Checking again shortly.
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert>
      <CloudSlashIcon />
      <AlertTitle>Couldn’t start controlling this camera</AlertTitle>
      <AlertDescription>{answer.message} Trying again shortly.</AlertDescription>
    </Alert>
  );
};
