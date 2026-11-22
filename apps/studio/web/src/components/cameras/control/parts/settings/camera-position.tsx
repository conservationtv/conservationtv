import { Suspense, type FC } from 'react';

import { cameraAxisReadingsOf } from '@/components/cameras/cameras';
import { useCameraHold } from '@/components/cameras/control/camera-control-context';
import { HolderName } from '@/components/cameras/control/parts/camera-lock';
import { linkOf, positionOf, useCamera, type CameraLink } from '@/components/cameras/control/store/camera-store';
import { Fact, FactLabel, Facts, FactValue } from '@/components/common/page';
import { StatusLabel, type Status } from '@/components/common/status';

// Where a camera points and who is at its controls, as the session's store has them from its agent
// (camera-store.ts). A camera is held by whoever last moved it, for a little while after: the agent names them by
// their device's public ID, which is a member's browser at these controls. For parts under a control session.

/** Who is at the camera's controls, in a few words. */
const Holder: FC = () => {
  const hold = useCameraHold();
  if (hold.by === 'unknown') return 'Unknown';
  if (hold.by === 'nobody') return 'Nobody';
  if (hold.by === 'self') return 'You';
  return (
    <Suspense fallback="Someone else">
      <HolderName peer={hold.peer} />
    </Suspense>
  );
};

/**
 * Where the camera points on each axis it reports, who holds it, and whether it is still being followed: live while
 * the stream is heard from, and the last that was known, said to be so, while it is lost or has gone quiet.
 */
export const CameraPosition: FC = () => {
  const position = useCamera(positionOf);
  const link = useCamera(linkOf);
  return (
    <div className="flex flex-col gap-3">
      <Facts>
        {position &&
          cameraAxisReadingsOf(position).map(reading => (
            <Fact key={reading.axis}>
              <FactLabel>{reading.axis}</FactLabel>
              <FactValue className="tabular-nums">{reading.value}</FactValue>
            </Fact>
          ))}
        <Fact>
          <FactLabel>At the controls</FactLabel>
          <FactValue>
            <Holder />
          </FactValue>
        </Fact>
        <Fact>
          <FactLabel>Following</FactLabel>
          <FactValue>
            <FollowingStatus />
          </FactValue>
        </Fact>
      </Facts>
      {link.status === 'lost' && (
        <p className="text-custom-12 text-custom-text-secondary">
          Lost the camera’s agent: {link.failure} Trying again shortly.
        </p>
      )}
      {link.status === 'stale' && (
        <p className="text-custom-12 text-custom-text-secondary">
          The camera’s agent stopped answering, so this may be out of date. Asking it again.
        </p>
      )}
    </div>
  );
};

/** How each state of following the camera's stream is said. */
const FOLLOWING = {
  idle: { status: 'off', label: 'Not following' },
  connecting: { status: 'unknown', label: 'Connecting' },
  live: { status: 'ok', label: 'Live' },
  reconnecting: { status: 'unknown', label: 'Reconnecting' },
  stale: { status: 'degraded', label: 'Not answering' },
  lost: { status: 'failing', label: 'Lost' }
} as const satisfies Record<CameraLink['status'], FollowingLabel>;

interface FollowingLabel {
  status: Status;
  label: string;
}

/**
 * Whether the camera's stream is being followed: yet to say anything, heard from, between one stream and the next,
 * gone quiet, or lost.
 */
const FollowingStatus: FC = () => {
  const link = useCamera(state => state.link.status);
  const following = FOLLOWING[link];
  return (
    <StatusLabel
      status={following.status}
      className={link === 'lost' ? 'text-custom-13' : 'text-custom-13 text-foreground'}
    >
      {following.label}
    </StatusLabel>
  );
};
