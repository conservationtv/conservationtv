import type { CameraCommand } from '@conservationtv/cameras';
import {
  type ChatAudience,
  type ChatCommandReason,
  type CarryResult,
  inAudience,
  type StandardCommandName,
  type StandardTarget
} from '@conservationtv/chat';
import type { AgentReference } from '../cameras/grants.ts';
import type { ShowFacts } from '../shows/resolve.ts';
import type { ChatCommandAction } from './commands.ts';
import type { NamedCamera } from './resolve.ts';
import type { ShowChange } from './shows.ts';
import { planStandard } from './standard.ts';

// What one use of a chat command comes to. A use runs through four processes, in this order:
//
//   listening agent         heard in the channel's chat; dropped there if the viewer isn't in the command's audience,
//    │                      or the command rests until a time this API last told it (`restsUntil`)
//    │ trigger
//    ▼
//   this API                1. authorised: the device is the agent of an output whose chat the channel's is: one
//    │                         it goes out to, or one of its control channels
//    │                      2. the command is there and enabled: the organisation's own,     else notRun: disabled
//    │                         or a standard one it hasn't switched off
//    │                      3. the viewer is in its audience                             else notRun: audience
//    │                      4. its words name what it acts on                            else notRun: unresolved
//    │                         a camera, and what to tell it, for a camera command (src/chat/cameras.ts);
//    │                         streams of the show, a layout or a mix, for a layout or audio one (src/chat/shows.ts)
//    │                      5. there is something to act with                            else notRun: unavailable
//    │                         an agent reaches the camera; the output follows a show
//    │                         (why 4 or 5 failed is said in chat only to a moderator or the broadcaster: `toldWhy`)
//    │                      6. its turn is taken: the cooldown is spent, here and only here   else notRun: resting
//    │                         an own command's turn is its own; a standard one's is per camera or per show
//    │                      7. a reply is said in chat (ran); or the show is changed, then said so (ran), and its
//    │                         object poked once that has committed (src/shows/pokes.ts); or a grant is signed for
//    │                         each of the camera's commands (planned)
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
// typo leaves the command free for the corrected use straight after. Step 6 is the one write that decides, a
// conditional write (src/services/chat-commands.ts), so two uses at once cannot both take the turn; the decision
// names it `resting` already when the facts show the command resting, and the write has the last word. A layout or
// audio command reads its show holding the show's row, so what it decided against is still so when its change is
// written, after the turn, in the same transaction. Chat is told a camera moves only once it has: what is said of a
// planned use waits for its settlement. A layout or audio command finishes here, so its agent carries nothing.

/** What a command is when it is used, whichever it is: who may use it, and how long it rests after it runs. */
interface Usable {
  audience: ChatAudience;
  cooldownSeconds: number;
}

/** One of the organisation's own commands: it replies, and has one turn. */
export interface OwnCommand extends Usable {
  kind: 'own';
  id: string;
  action: ChatCommandAction;
  triggeredAt: Date | null;
}

/** A standard command, as the organisation has it: a turn per camera or per show, by its ID, while it rests. */
export interface StandardUse extends Usable {
  kind: 'standard';
  name: StandardCommandName;
  target: StandardTarget;
  turns: ReadonlyMap<string, Date | null>;
}

/** The command as it is used. */
export type UsedCommand = OwnCommand | StandardUse;

/** When a command last ran, and how long it rests after. */
export interface Rest {
  cooldownSeconds: number;
  triggeredAt: Date | null;
}

/** Everything a use is decided from, read before it is decided. */
export interface UseFacts {
  /** The command, if it is there and enabled. */
  command: UsedCommand | undefined;
  /** What the viewer is in the channel, as its platform says. */
  roles: readonly ChatAudience[];
  /** The words that followed the command, in order. */
  words: readonly string[];
  /** The organisation's cameras as chat finds them: read only for a standard command. */
  cameras: readonly NamedCamera[];
  /** The agent that reaches each camera, by camera: one without is not in it. Read only for a camera command. */
  servingAgents: ReadonlyMap<string, AgentReference>;
  /** The show the output follows, and what it is resolved from: read only for a standard command, none for no show. */
  show: ShowFacts | undefined;
  now: Date;
}

/** Whose turn a use takes: an own command's, or a standard command's on one camera or show. */
export type Turn = OwnTurn | StandardTurn;

export interface OwnTurn {
  kind: 'own';
  commandId: string;
}

export interface StandardTurn {
  kind: 'standard';
  command: StandardCommandName;
  targetId: string;
}

/** What a use comes to before anything is written. */
export type Decision = NotRun | Run;

/** Nothing runs, and the command's turn is not taken: why, what to say about it if anything, and its rest. */
export interface NotRun {
  kind: 'notRun';
  reason: ChatCommandReason;
  reply: string | null;
  /** When the command's rest ends, while it rests; null when it doesn't, is gone, or rests per target not yet named. */
  restsUntil: Date | null;
}

/** Take the turn, then do this. */
export interface Run {
  kind: 'run';
  turn: Turn;
  effect: Effect;
}

/** What a use that runs does. */
export type Effect = Say | ShowCommand | Move;

/** Say this in chat. */
export interface Say {
  kind: 'say';
  text: string;
}

/** Change the show as it was decided against, and say this in chat. */
export interface ShowCommand {
  kind: 'show';
  show: ShowFacts;
  change: ShowChange;
  text: string;
}

/** Tell the camera these commands, in order, through the agent that reaches it; say this once it has taken them. */
export interface Move {
  kind: 'move';
  camera: Pick<NamedCamera, 'id' | 'name'>;
  agent: AgentReference;
  commands: CameraCommand[];
  text: string;
}

/**
 * What a standard command plans, before its rest is looked at: the camera or show it takes its turn on, and its effect.
 */
export interface StandardPlan {
  kind: 'plan';
  targetId: string;
  effect: Effect;
}

export const notRun = (reason: ChatCommandReason, restsUntil: Date | null, reply: string | null = null): NotRun => ({
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
  // An own command rests as a whole; a standard one only on the target its words name, not known until they are read.
  const ownRest = command.kind === 'own' ? restsUntil(command, now) : null;
  // Who may use it before anything else is said of it, so someone who may not is told nothing.
  if (!inAudience(command.audience, facts.roles)) return notRun('audience', ownRest);
  const planned = plan(command, facts);
  if (planned.kind === 'notRun') {
    return { ...planned, reply: toldWhy(facts.roles) ? planned.reply : null, restsUntil: ownRest };
  }
  // Resting last: a use that would come to nothing is decided as such even while the command rests, and spends nothing.
  const rest = command.kind === 'own' ? ownRest : restOn(command, planned.targetId, now);
  if (rest !== null) return notRun('resting', rest);
  const turn: Turn =
    command.kind === 'own'
      ? { kind: 'own', commandId: command.id }
      : { kind: 'standard', command: command.name, targetId: planned.targetId };
  return { kind: 'run', turn, effect: planned.effect };
}

/** When a standard command's rest on a target ends, while it rests there. */
function restOn(command: StandardUse, targetId: string, now: Date): Date | null {
  const triggeredAt = command.turns.get(targetId) ?? null;
  return restsUntil({ cooldownSeconds: command.cooldownSeconds, triggeredAt }, now);
}

/** What the command comes to with these facts, its rest aside. */
function plan(command: UsedCommand, facts: UseFacts): StandardPlan | NotRun {
  if (command.kind === 'own')
    return { kind: 'plan', targetId: command.id, effect: { kind: 'say', text: command.action.text } };
  return planStandard(command.name, facts);
}

/** What is said in chat of a planned move, once the agent that carried it says what came of it. */
export function settledReply(result: CarryResult, camera: string, carried: string, told: boolean): string | null {
  if (result === 'carried') return carried;
  // Not carried, the turn is given back and nothing is spent: said only to a viewer told why (`toldWhy`).
  if (!told) return null;
  if (result === 'held') return `Someone is controlling ${camera} right now.`;
  return `${camera} can't be moved right now.`;
}
