import { queryOptions } from '@tanstack/react-query';
import { CAMERA_GRANT_HEADER, type CameraCapabilities, type CameraCommand } from '@conservationtv/cameras';
import { HttpError } from '@conservationtv/studio-sdk';

import { askAgent, browserPeerOf } from '@/lib/agent-connection';
import { api } from '@/lib/api';

// Controlling a camera from the browser. The studio API says which agent reaches the camera and signs a grant for
// this browser's device to control it (apps/studio/api/src/routes/cameras.ts); everything after that is asked of the
// agent directly over iroh (src/lib/agent-connection.ts), each command carrying the grant: what the camera can do, and
// the commands themselves. Where the camera points as it moves is the agent's event stream, which is followed rather
// than queried (src/components/cameras/control/camera-live.tsx). Each answer here is one of a few named outcomes, told
// apart by its `status`, so whatever reads one says which it is handling.

/** How long before a grant expires another is asked for, so the controls never hold one about to run out. */
const GRANT_MARGIN_MS = 60_000;
/** How often a camera that couldn't be controlled is asked about again: it may be enabled, or its agent come back. */
const UNAVAILABLE_RETRY_MS = 20_000;
/** How often an agent is asked what its cameras can do: often until each has answered it, then rarely. */
const UNANSWERED_MS = 3_000;
const CAPABILITIES_MS = 60_000;

/** The agent that reaches a camera, the grant its commands carry, and this browser's device, as the agent sees it. */
export interface CameraControlSession {
  agent: CameraControlAgent;
  grant: string;
  /** ISO 8601: when the grant stops admitting commands. */
  expiresAt: string;
  /** This browser's device's public ID: the peer the agent names as holding the camera while these controls do. */
  peer: string;
}

/** The agent to dial, by its public ID. */
interface CameraControlAgent {
  id: string;
  publicId: string;
}

/** The camera can be controlled: through this session. */
interface CameraControlGranted {
  status: 'granted';
  session: CameraControlSession;
}

/**
 * The camera can't be controlled from here, and why: the account isn't an administrator, the camera isn't enabled or
 * its network has no active agent, or the grant couldn't be asked for at all.
 */
export interface CameraControlRefused {
  status: 'refused';
  reason: 'forbidden' | 'unavailable' | 'failed';
  message: string;
}

/** What the studio says to controlling a camera from here. */
export type CameraControlAnswer = CameraControlGranted | CameraControlRefused;

/**
 * Ask for the grant. It is made out to this session's browser device in the organisation, so that device comes first:
 * binding the organisation's iroh session makes it exist, and names it.
 */
async function connectToCamera(organisationId: string, cameraId: string): Promise<CameraControlSession> {
  const peer = await browserPeerOf(organisationId);
  const result = await api.organisations.cameras.control.connect.v1({ id: organisationId, cameraId });
  if (result instanceof Error) throw result;
  return { agent: result.agent, grant: result.grant, expiresAt: result.expiresAt, peer };
}

/** Which of the reasons a failure to connect is, by the API's status. */
function refusalOf(failure: Error): CameraControlRefused {
  const status = failure instanceof HttpError ? failure.status : undefined;
  if (status === 403) return { status: 'refused', reason: 'forbidden', message: failure.message };
  if (status === 503) return { status: 'refused', reason: 'unavailable', message: failure.message };
  return { status: 'refused', reason: 'failed', message: failure.message };
}

/** How long until a grant is to be asked for again: a margin before it runs out, and never at once. */
function renewalIn(session: CameraControlSession): number {
  return Math.max(Date.parse(session.expiresAt) - Date.now() - GRANT_MARGIN_MS, UNANSWERED_MS);
}

/**
 * Who reaches the camera, and a grant to control it through them. Administrators only. A grant lasts about five
 * minutes, so while something shows the controls it is asked for again a minute before it runs out. A camera that
 * can't be controlled comes back as why, rather than thrown, so its page can say so in place; unless that is the
 * account's own standing, it is asked about again shortly. Never kept between visits: a grant from the last one may
 * have expired.
 */
export const cameraControlQueryOptions = (organisationId: string, cameraId: string) =>
  queryOptions({
    queryKey: ['cameras', organisationId, 'control', cameraId] as const,
    queryFn: async (): Promise<CameraControlAnswer> => {
      try {
        const session = await connectToCamera(organisationId, cameraId);
        return { status: 'granted', session };
      } catch (error) {
        return refusalOf(error instanceof Error ? error : new Error(String(error)));
      }
    },
    staleTime: 0,
    gcTime: 0,
    refetchInterval: query => {
      const answer = query.state.data;
      if (!answer) return false;
      if (answer.status === 'granted') return renewalIn(answer.session);
      return answer.reason === 'forbidden' ? false : UNAVAILABLE_RETRY_MS;
    }
  });

/** Ask an agent for its cameras: them, or why it couldn't be asked. */
async function listAgentCameras(organisationId: string, agentPublicId: string) {
  try {
    const answer = await askAgent(organisationId, agentPublicId, agent => agent.cameras.list.v1());
    return { cameras: answer.cameras };
  } catch (error) {
    return { failure: error instanceof Error ? error.message : String(error) };
  }
}

/** An agent's answer about its cameras, or its failure to give one. */
type AgentCameraList = Awaited<ReturnType<typeof listAgentCameras>>;

/**
 * The cameras an agent controls, each with what it can do as the camera itself says: null until the camera has
 * answered the agent, so it is asked again every few seconds until each has. An agent that can't be reached comes back
 * as its failure's message, as `agentSystemQueryOptions` does, and is tried again a little less often.
 */
export const agentCameraListQueryOptions = (organisationId: string, agentPublicId: string) =>
  queryOptions({
    queryKey: ['agent-direct', organisationId, agentPublicId, 'cameras'] as const,
    queryFn: () => listAgentCameras(organisationId, agentPublicId),
    staleTime: 0,
    gcTime: 0,
    refetchInterval: query => {
      const answer = query.state.data;
      if (!answer) return false;
      if ('failure' in answer) return UNAVAILABLE_RETRY_MS;
      return answer.cameras.some(camera => camera.capabilities === null) ? UNANSWERED_MS : CAPABILITIES_MS;
    }
  });

/** The agent couldn't be asked what the camera can do. */
interface CameraAgentUnreachable {
  status: 'unreachable';
  failure: string;
}

/** The agent answers, but hasn't been configured with the camera yet, or hasn't heard from it. */
interface CameraUnanswered {
  status: 'unanswered';
}

/** The camera has told its agent what it can do. */
interface CameraAnswered {
  status: 'answered';
  capabilities: CameraCapabilities;
}

/** What is known of what a camera can do, as the agent that reaches it says. */
export type CameraAbility = CameraAgentUnreachable | CameraUnanswered | CameraAnswered;

/** What an agent's answer says of one camera. */
export function cameraAbilityOf(answer: AgentCameraList, cameraId: string): CameraAbility {
  if (answer.cameras === undefined) return { status: 'unreachable', failure: answer.failure };
  const capabilities = answer.cameras.find(camera => camera.id === cameraId)?.capabilities ?? null;
  return capabilities === null ? { status: 'unanswered' } : { status: 'answered', capabilities };
}

/** What the agent's refusals of a command mean to someone at the controls, by the code each carries. */
const COMMAND_REFUSALS = new Map([
  ['camera_held', 'Someone else is controlling this camera. It takes your commands once they let go.'],
  ['grant_refused', 'The camera’s agent didn’t accept this session’s permission to control it. Try again in a moment.'],
  ['unsupported_command', 'This camera can’t do that.'],
  ['camera_failed', 'The camera didn’t take the command. It may be busy, or unreachable from its agent.']
]);

/** A failed command, saying what it means here where the agent's code is one of those known. */
function commandFailureOf(failure: Error): Error {
  const code = failure instanceof HttpError ? failure.code : undefined;
  const meaning = code === undefined ? undefined : COMMAND_REFUSALS.get(code);
  return meaning === undefined ? failure : new Error(meaning, { cause: failure });
}

/**
 * Send one command to a camera through its agent, carrying the session's grant. A `drive` keeps the camera moving
 * only while it is sent again: the agent stops one not driven for a second and a half.
 */
export async function runCameraCommand(
  organisationId: string,
  cameraId: string,
  session: CameraControlSession,
  command: CameraCommand
): Promise<void> {
  try {
    await askAgent(organisationId, session.agent.publicId, agent =>
      agent.cameras.commands.run.v1({ cameraId, command }, { headers: { [CAMERA_GRANT_HEADER]: session.grant } })
    );
  } catch (error) {
    throw commandFailureOf(error instanceof Error ? error : new Error(String(error)));
  }
}
