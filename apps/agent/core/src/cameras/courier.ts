import { CAMERA_GRANT_HEADER, type CameraCommand } from '@conservationtv/cameras';
import type { CarryResult } from '@conservationtv/chat';
import type { DeviceIdentity } from '@conservationtv/studio-sdk';
import { getLogger } from '@logtape/logtape';
import { z } from 'zod';
import type { AgentDialler } from '../iroh/dial.ts';
import { CameraHeld, type CameraControl } from './control.ts';
import { GrantRefused, verifyGrant } from './grants.ts';

// Carrying a camera command the studio API resolved to the agent that reaches the camera. The agent that hears a chat
// command is rarely the one on the camera's network, so it is handed the command with a grant for exactly it, and
// takes both there over iroh: the same call the studio's controls make. When this agent is the one that reaches the
// camera it runs the command itself, checking the grant all the same.
//
// Whatever happens, carrying comes back with what came of it, in the words the studio API settles a use in
// (`@conservationtv/chat`), and never throws: each failure is read as one of them here, in one place (`resultOf`):
//
//   carried       the camera took the command
//   held          someone is at the camera's controls: `CameraHeld` here, `camera_held` (409) there
//   unreachable   the agent that reaches it wasn't: the dial or the request failed, or it took too long
//   refused       the grant admits nothing there: `GrantRefused` here, 401 or 403 there
//   failed        anything else: the camera didn't take the command, or isn't controlled there

const logger = getLogger(['agent', 'cameras']);

/** A command for a camera, as the studio API resolved it: where to take it, and what admits it there. */
export interface CarriedCommand {
  agent: ServingAgent;
  cameraId: string;
  command: CameraCommand;
  grant: string;
}

/** The agent that reaches a camera. */
interface ServingAgent {
  /** Its endpoint ID. */
  publicId: string;
}

/** The agent that reaches the camera answered. */
interface Answered {
  kind: 'response';
  response: Response;
  body: string;
}

/** Carrying it threw: here, what the camera's control turned it away with; over iroh, the dial or the request. */
interface Thrown {
  kind: 'thrown';
  error: unknown;
  remote: boolean;
}

/** It was given up on before it ended. */
interface Abandoned {
  kind: 'abandoned';
}

/** It was carried out here. */
interface Done {
  kind: 'done';
}

/** What carrying a command can come up against, before what came of it is read (`resultOf`). */
type Carrying = Answered | Thrown | Abandoned | Done;

/** Carries resolved camera commands to the agent that serves each camera. */
export interface Courier {
  /** Carry out the command, here or at the agent it names, giving up once `signal` aborts: what came of it. */
  carry: (carried: CarriedCommand, signal: AbortSignal) => Promise<CarryResult>;
}

/** The agent API's error body, as far as it is read here: its code. */
const ErrorBodySchema = z.object({ error: z.string() });
type ErrorBody = z.output<typeof ErrorBodySchema>;

/** The code an agent API error body names, if it is one. */
function codeOf(body: string): ErrorBody['error'] | undefined {
  try {
    const json: unknown = JSON.parse(body);
    const parsed = ErrorBodySchema.safeParse(json);
    return parsed.success ? parsed.data.error : undefined;
  } catch {
    // Not JSON at all: no code.
    return undefined;
  }
}

/** What came of it when carrying threw. */
function thrownResult({ error, remote }: Thrown): CarryResult {
  if (error instanceof CameraHeld) return 'held';
  if (error instanceof GrantRefused) return 'refused';
  // Over iroh, a throw is the dial or the connection failing: the request never had an answer.
  return remote ? 'unreachable' : 'failed';
}

/** What came of it when the agent that reaches the camera answered. */
function answeredResult({ response, body }: Answered): CarryResult {
  if (response.ok) return 'carried';
  if (response.status === 409 && codeOf(body) === 'camera_held') return 'held';
  if (response.status === 401 || response.status === 403) return 'refused';
  return 'failed';
}

/** What came of carrying a command, from what it came up against: the one place a failure is given its name. */
export function resultOf(carrying: Carrying): CarryResult {
  switch (carrying.kind) {
    case 'done':
      return 'carried';
    case 'abandoned':
      // Whatever reaches the camera didn't answer in time.
      return 'unreachable';
    case 'thrown':
      return thrownResult(carrying);
    case 'response':
      return answeredResult(carrying);
  }
}

/** Takes resolved camera commands to the agent that serves each camera. */
export class CameraCourier implements Courier {
  constructor(
    private readonly identity: DeviceIdentity,
    private readonly control: CameraControl,
    private readonly dialler: AgentDialler
  ) {}

  async carry(carried: CarriedCommand, signal: AbortSignal): Promise<CarryResult> {
    const { agent, cameraId } = carried;
    const local = agent.publicId === this.identity.publicId;
    const attempt = local ? this.runHere(carried) : this.takeThere(carried, signal);
    const abandoned = new Promise<Carrying>(resolve => {
      if (signal.aborted) resolve({ kind: 'abandoned' });
      signal.addEventListener('abort', () => resolve({ kind: 'abandoned' }), { once: true });
    });
    const carrying = await Promise.race([attempt, abandoned]);
    const result = resultOf(carrying);
    if (result !== 'carried') {
      const detail = detailOf(carrying);
      logger.warn('The command for camera {cameraId} at {agent} came to {result}: {detail}', {
        cameraId,
        agent: agent.publicId,
        result,
        detail
      });
    }
    return result;
  }

  /** Run the command here, checking its grant as the agent API's route would. */
  private async runHere({ cameraId, command, grant }: CarriedCommand): Promise<Carrying> {
    const { identity, control } = this;
    const check = { issuer: control.grantIssuer, identity, peer: identity.publicId };
    try {
      const admitted = await verifyGrant(grant, check);
      await control.run(cameraId, command, admitted);
      return { kind: 'done' };
    } catch (error) {
      return { kind: 'thrown', error, remote: false };
    }
  }

  /** Send the command to the agent that reaches the camera, over iroh. */
  private async takeThere(carried: CarriedCommand, signal: AbortSignal): Promise<Carrying> {
    const { agent, cameraId, command, grant } = carried;
    try {
      const response = await this.dialler.fetch(agent.publicId, `/cameras/${cameraId}/commands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Operation-Version': '1', [CAMERA_GRANT_HEADER]: grant },
        body: JSON.stringify({ command }),
        signal
      });
      const body = await response.text();
      return { kind: 'response', response, body };
    } catch (error) {
      return { kind: 'thrown', error, remote: true };
    }
  }
}

/** What to log of what carrying came up against. */
function detailOf(carrying: Carrying): string {
  if (carrying.kind === 'done') return 'done';
  if (carrying.kind === 'abandoned') return 'given up on';
  if (carrying.kind === 'response') return `HTTP ${carrying.response.status} ${carrying.body.slice(0, 200)}`;
  const { error } = carrying;
  return error instanceof Error ? error.message : String(error);
}
