import { StateSchema } from '@conservationtv/agent-sdk';

import type { CameraAgent, CameraHeard, CameraReport } from '@/components/cameras/control/camera-store';
import { streamFromAgent } from '@/lib/agent-connection';
import { serverSentEvents } from '@/lib/server-sent-events';
import type { CameraControlSession } from '@/queries/camera-control';

// A camera's agent's event stream (`GET /cameras/{cameraId}/events`), read over iroh and turned into what the
// session's store hears. This is not a query: nothing is cached or refetched. The following itself (asking for a
// stream, hearing it, asking again when it ends, fails or goes quiet) is the link machine in the store
// (camera-store.ts), which opens a stream through this as an effect and lets go of it with the signal; camera-live.tsx
// starts and stops it.

/** The state a `state` event carries, or undefined for one that isn't as this app knows it. */
function reportOf(data: string): CameraReport | undefined {
  try {
    return StateSchema.parse(JSON.parse(data));
  } catch {
    return undefined;
  }
}

/**
 * One stream of the camera's, through the session's agent, until it ends. Each event is heard: a state as the camera's
 * state, and anything else (the agent's `ping`, or a state this app can't read) as a sign the stream is alive.
 */
async function* heardFrom(
  organisationId: string,
  cameraId: string,
  session: CameraControlSession,
  signal: AbortSignal
): AsyncGenerator<CameraHeard> {
  const path = `/cameras/${encodeURIComponent(cameraId)}/events`;
  const response = await streamFromAgent(organisationId, session.agent.publicId, path, signal);
  if (!response.body) return;
  for await (const event of serverSentEvents(response.body, signal)) {
    const report = event.event === 'state' ? reportOf(event.data) : undefined;
    yield report === undefined ? { kind: 'sign' } : { kind: 'state', report };
  }
}

/** How the session's store listens to a camera: a stream through whichever agent its session names when it asks. */
export function cameraListenerOf(organisationId: string, cameraId: string): CameraAgent['listen'] {
  return (session, signal) => heardFrom(organisationId, cameraId, session, signal);
}
