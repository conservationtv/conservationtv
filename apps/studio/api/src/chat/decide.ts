import type { CameraCommand } from '@conservationtv/cameras';
import { type ChatAudience, type ChatCommandReason, type CarryResult, inAudience } from '@conservationtv/chat';
import type { AgentReference } from '../cameras/grants.ts';
import type { ChatCommandAction } from './commands.ts';
import { type NamedCamera, type NamedPreset, resolveCameraPreset } from './resolve.ts';

// What one use of a chat command comes to. A use runs through four processes, in this order:
//
//   listening agent         heard in the channel's chat; dropped there if the viewer isn't in the command's audience,
//    │                      or the command rests until a time this API last told it (`restsUntil`)
//    │ trigger
//    ▼
//   this API                1. authorised: the device is the agent of an output that goes out to the channel
//    │                      2. the command is there and enabled                          else notRun: disabled
//    │                      3. the viewer is in its audience                             else notRun: audience
//    │                      4. its words name a camera and preset it can use             else notRun: unresolved
//    │                      5. an agent reaches that camera                              else notRun: unavailable
//    │                         (why 4 or 5 failed is said in chat only to a moderator or the broadcaster: `toldWhy`)
//    │                      6. its turn is taken: the cooldown is spent, here and only here   else notRun: resting
//    │                      7. a reply is said in chat (ran), or a grant is signed for the move (planned)
//    │ planned: cameraCommands, receipt
//    ▼
//   listening agent         carries each command to the agent that reaches the camera
//    │ over iroh
//    ▼
//   serving agent           checks the grant, gives way to whoever is at the camera's controls, moves the camera
//    │
//    ▼
//   listening agent         settles the use with what came of it: carried, held, unreachable, refused or failed
//    │ settle
//    ▼
//   this API                says so in chat; when it wasn't carried, gives the command's turn back, and says why only
//                           to a moderator or the broadcaster
//
// Steps 2 to 5 are decided here, from facts read first, so the decision is pure: the same facts come to the same
// thing wherever it is made. Nothing up to step 5 writes anything, so a use that comes to nothing spends nothing: a
// typo leaves the command free for the corrected use straight after. Step 6 is the one write, a
// conditional UPDATE (src/services/chat-commands.ts), so two uses at once cannot both take the turn; the decision
// names it `resting` already when the facts show the command resting, and the UPDATE has the last word. Chat is told
// a camera moves only once it has: what is said of a planned use waits for its settlement.

/** The command as it is used: what it does, for whom, and when it last ran and how long it rests after. */
export interface UsedCommand {
  action: ChatCommandAction;
  audience: ChatAudience;
  cooldownSeconds: number;
  triggeredAt: Date | null;
}

/** When a command last ran, and how long it rests after. */
export type Rest = Pick<UsedCommand, 'cooldownSeconds' | 'triggeredAt'>;

/** Everything a use is decided from, read before it is decided. */
export interface UseFacts {
  /** The command, if it is there and enabled. */
  command: UsedCommand | undefined;
  /** What the viewer is in the channel, as its platform says. */
  roles: readonly ChatAudience[];
  /** The words that followed the command, in order. */
  words: readonly string[];
  /** The organisation's cameras as chat finds them: read only for a command that points one. */
  cameras: readonly NamedCamera[];
  /** The agent that reaches each camera, by camera: one without is not in it. */
  servingAgents: ReadonlyMap<string, AgentReference>;
  now: Date;
}

/** What a use comes to before anything is written. */
export type Decision = NotRun | Reply | Move;

/** Nothing runs, and the command's turn is not taken: why, what to say about it if anything, and its rest. */
export interface NotRun {
  kind: 'notRun';
  reason: ChatCommandReason;
  reply: string | null;
  /** When the command's rest ends, while it rests; null when it doesn't, or is gone. */
  restsUntil: Date | null;
}

/** Take the command's turn, then say this in chat. */
export interface Reply {
  kind: 'reply';
  text: string;
}

/** Take the command's turn, then point the camera at the preset, through the agent that reaches it. */
export interface Move {
  kind: 'move';
  camera: Pick<NamedCamera, 'id' | 'name'>;
  preset: Pick<NamedPreset, 'name'>;
  agent: AgentReference;
  command: CameraCommand;
}

const notRun = (reason: ChatCommandReason, restsUntil: Date | null, reply: string | null = null): NotRun => ({
  kind: 'notRun',
  reason,
  reply,
  restsUntil
});

/**
 * Whether a viewer is told why their use came to nothing. Such a use spends nothing, so the cooldown can't bound how
 * often it is answered: only those trusted to moderate the chat are told, so no one else can have the broadcaster's
 * account post at their pace.
 */
export function toldWhy(roles: readonly ChatAudience[]): boolean {
  return inAudience('moderator', roles);
}

/** When the command's rest ends, while it rests at `now`: null when it never ran, or its rest is over. */
export function restsUntil(rest: Rest, now: Date): Date | null {
  if (rest.triggeredAt === null) return null;
  const until = new Date(rest.triggeredAt.getTime() + rest.cooldownSeconds * 1000);
  return until > now ? until : null;
}

/** What the use comes to, in the order above: the first step it falls at, or what to do once its turn is taken. */
export function decideUse(facts: UseFacts): Decision {
  const { command, now } = facts;
  if (command === undefined) return notRun('disabled', null);
  const rest = restsUntil(command, now);
  // Who may use it before anything else is said of it, so someone who may not is told nothing.
  if (!inAudience(command.audience, facts.roles)) return notRun('audience', rest);
  const planned = plan(command.action, facts);
  if (planned.kind === 'notRun') {
    return { ...planned, reply: toldWhy(facts.roles) ? planned.reply : null, restsUntil: rest };
  }
  // Resting last: a use that would come to nothing is decided as such even while the command rests, and spends nothing.
  if (rest !== null) return notRun('resting', rest);
  return planned;
}

/** What the command's action comes to with these facts, its rest aside. */
function plan(action: ChatCommandAction, facts: UseFacts): Decision {
  if (action.kind === 'reply') return { kind: 'reply', text: action.text };
  const resolution = resolveCameraPreset(action, facts.words, facts.cameras);
  if (!resolution.ok) return notRun('unresolved', null, resolution.reply);
  const { camera, preset } = resolution;
  const agent = facts.servingAgents.get(camera.id);
  if (agent === undefined) return notRun('unavailable', null, `${camera.name} can't be moved right now.`);
  const command: CameraCommand = { kind: 'moveTo', ...preset.position };
  return {
    kind: 'move',
    camera: { id: camera.id, name: camera.name },
    preset: { name: preset.name },
    agent,
    command
  };
}

/** What is said in chat of a planned move, once the agent that carried it says what came of it. */
export function settledReply(result: CarryResult, camera: string, preset: string, told: boolean): string | null {
  if (result === 'carried') return `Moving ${camera} to ${preset}.`;
  // Not carried, the turn is given back and nothing is spent: said only to a viewer told why (`toldWhy`).
  if (!told) return null;
  if (result === 'held') return `Someone is controlling ${camera} right now.`;
  return `${camera} can't be moved right now.`;
}
