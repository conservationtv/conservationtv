import { useEffect, type FC } from 'react';

import { useCameraStore } from '@/components/cameras/control/store/camera-store';

// Following a camera as it moves. The following itself (asking for its agent's stream, hearing it, asking again when
// it ends, fails or goes quiet) is the link machine in the session's store (camera-store.ts), which owns the stream
// (camera-stream.ts) and its timers as effects. All that is here is the part that starts it and stops it.

/**
 * Follows the camera being controlled through its agent for as long as it is rendered: starts the session's link
 * when it mounts, and stops it, letting go of the stream and calling off its timers, when it is taken away. Shows
 * nothing.
 */
export const CameraFollowing: FC = () => {
  const store = useCameraStore();
  useEffect(() => {
    store.trigger.started();
    return () => store.trigger.stopped();
  }, [store]);
  return null;
};
