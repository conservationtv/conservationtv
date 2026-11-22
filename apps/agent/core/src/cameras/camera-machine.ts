import type {
  CameraCapabilities,
  CameraCommand,
  CameraGrantPriority,
  CameraOptionValues,
  CameraPosition
} from '@conservationtv/cameras';
import type { CameraDriver } from '@conservationtv/cameras/control';
import { getLogger } from '@logtape/logtape';
import { createStore, type EnqueueObject, type ExtractEvents, type Store } from '@xstate/store';
import { Alarms as StateAlarms, type Time, within as withinTime } from '../time.ts';
import type { CameraControlState, CameraHolder } from './control.ts';

// What the agent knows of one camera it controls, in one store (control.ts keeps one for each), and the grants it
// has seen used, in another. Everything that changes is an event below, and each event says what changed and when:
// the store never reads the clock, and never talks to the camera itself. What has to happen because of a change
// (asking the camera something, telling it to do something, logging) is an effect the change asks for, run once the
// change is made, which reports back as another event. The timers are not kept by the store at all: what it should
// be woken for, and when, is read off its state (`alarmsOf`), and `Alarms` keeps the timers that say so. So
// `store.transition(snapshot, event)` says everything the camera's control does, with nothing sent to the camera and
// no time passing, and the clock and the timers are whatever `Time` they are given.
//
// A camera's store holds five things, each a small machine of its own:
//
//   life     whether the camera is still controlled here. One that is let go while it may be moving is stopped first:
//
//              controlled ── released, not being driven; or disposed of ──────────────────────▶ released
//                   │                                                                              ▲
//                   └── released while being driven ──▶ releasing ── its stop answered, or not ───┘
//
//            One let go of with a stop it didn't take is `released` as maybe `moving`: when a new registration
//            replaces it, the new one is `adopted` as being driven with its deadline come, and so stopped at once.
//
//   hold     who is at the camera's controls. A person's command takes the camera, from anyone, until `HOLD_MS`
//            after it; automation's command neither takes it nor renews it, and is turned away while someone other
//            than whoever sent it holds it. The hold ends at its time, as an event of its own, so the status and
//            whoever watches hear that nobody holds the camera when it happens:
//
//              free ── a person's command ──▶ held(peer, until) ── until passes ──▶ free
//                                               │  ▲
//                                               └──┘ a person's command: theirs, until HOLD_MS from now
//
//   drive    whether the camera may be moving on a `drive`, and so has a stop coming. A drive is taken to reach the
//            camera whether or not it answers: one that times out may have got there all the same. So sending one
//            arms the deadline, far enough off to cover its answer, and its answer, either way, sets it to
//            `DRIVE_TIMEOUT_MS` from then. Only a later move or stop the camera took, which it carried out after the
//            drive, says the camera is no longer driven; one that failed says nothing, and neither does setting an
//            option or running an action, which leave the deadline where it was. A deadline that passes stops the camera, and a stop the camera doesn't take is tried
//            again after another `DRIVE_TIMEOUT_MS`, for as long as the camera is controlled:
//
//              idle ── drive sent ──▶ driving(deadline) ── deadline passes ──▶ stopping ── stop taken ──▶ idle
//                ▲     (or adopted)    │  ▲     ▲                               │
//                │                     │  │     └──────── stop not taken ───────┘
//                │                     │  └─ drive sent, or the latest one answered (or not): a new deadline
//                └── a move or stop sent later than the last drive (or stop) is taken ──┘   (from stopping too)
//
//            Commands are numbered as they are sent (`seq`), and are taken to reach the camera in that order: the
//            drive that counts is the last one sent, and a command replaces it only if it was sent after it.
//
//   watch    the camera's state while anyone watches it: asked every `WATCH_INTERVAL_MS` (`DRIVEN_INTERVAL_MS` while it
//            may be moving), its options every `OPTIONS_EVERY` asks, and both at once after a command, which may
//            have changed them. The state told is the last that differed from the one before (in position, options
//            or holder), replayed to whoever starts watching; a change of holder is told when it happens:
//
//              unwatched ── a watcher joins ──▶ asking ── answered, or not ──▶ resting
//                  ▲                            ▲  │  (a command meanwhile:        │
//                  │                            │  └── asked again at once)       │
//                  │                            └──── rest ends, or a command ────┘
//                  └───────────── the last watcher leaves, from either ──────────────
//
//   capabilities  what the camera can do, asked once and again each time it is wanted until it answers:
//
//              unknown ── wanted ──▶ asking ── answered ──▶ known
//                 ▲                    │
//                 └─── not answered ───┘
//
// The grants (one store for all the cameras, since a camera's registration changing doesn't make a used grant new):
//
//   grant    unseen ── a command it admits is sent ──▶ used(until it expires) ── expires ──▶ forgotten
//
//            A grant for one command is turned away while it is used; one that has expired is turned away before it
//            gets here (grants.ts), so it is forgotten the next time any grant is spent.

const logger = getLogger(['agent', 'cameras']);

/** How long a camera has to do what it is told, or to say where it is. */
export const CAMERA_TIMEOUT_MS = 5_000;
/** How long after a person's last command the camera is still theirs. */
export const HOLD_MS = 15_000;
/** How long a `drive` moves the camera without being repeated. */
export const DRIVE_TIMEOUT_MS = 1_500;
/** How often a watched camera is asked where it is. */
export const WATCH_INTERVAL_MS = 1_000;
/** How often while it is being driven, so whoever follows it sees it move rather than jump. */
export const DRIVEN_INTERVAL_MS = 250;
/** How many of those asks pass between asking what its options are set to, which change far less. */
export const OPTIONS_EVERY = 5;

// The time the camera's control keeps, the clock and timers on it, is the agent's (time.ts): the real one, unless told
// otherwise.
export { realTime, type Time } from '../time.ts';

interface Controlled {
  status: 'controlled';
}

interface Releasing {
  status: 'releasing';
  /** The stop it was let go with. */
  seq: number;
}

interface Released {
  status: 'released';
  /** It was let go of with a stop it didn't take, so it may still be moving. */
  moving: boolean;
}

/** Whether the camera is controlled here, being let go of, or let go. */
export type Life = Controlled | Releasing | Released;

interface Free {
  status: 'free';
}

interface Held {
  status: 'held';
  /** The endpoint ID of their device. */
  peer: string;
  /** Epoch milliseconds. */
  until: number;
}

/** Who is at the camera's controls. */
export type Hold = Free | Held;

interface Idle {
  status: 'idle';
}

interface Driving {
  status: 'driving';
  /** The command after which it may be moving: the latest drive sent, or the agent's stop it didn't take. */
  since: number;
  /** Epoch milliseconds: when it is stopped unless a drive or a command comes first. */
  deadline: number;
}

interface Stopping {
  status: 'stopping';
  /** The agent's own stop, sent when the deadline passed. */
  seq: number;
}

/** Whether the camera may be moving on a drive, and so has a stop coming. */
export type Drive = Idle | Driving | Stopping;

interface Unwatched {
  status: 'unwatched';
}

/** What a watch keeps between one ask and the next. */
interface Watching {
  watchers: number;
  /** How many asks it has made: every `OPTIONS_EVERY`th reads the options too. */
  asks: number;
  /** What the options were last read as. */
  options: CameraOptionValues;
  /** The state last told, replayed to whoever starts watching: undefined until the camera first answers. */
  told: CameraControlState | undefined;
}

interface Asking extends Watching {
  status: 'asking';
  /** This ask, by which its answer is told from a stale one. */
  seq: number;
  /** A command was carried out since this ask was made: the camera is asked again at once, its options too. */
  stale: boolean;
}

interface Resting extends Watching {
  status: 'resting';
  /** Epoch milliseconds: when the rest began. How long it lasts depends on whether the camera is being driven. */
  since: number;
}

/** Whether anyone watches the camera, and where the asking is. */
export type Watch = Unwatched | Asking | Resting;

interface Unknown {
  status: 'unknown';
}

interface AskingCapabilities {
  status: 'asking';
}

interface Known {
  status: 'known';
  capabilities: CameraCapabilities;
}

/** What the camera can do, as far as it has said. */
export type Capabilities = Unknown | AskingCapabilities | Known;

export interface CameraContext {
  /** The camera's ID. */
  id: string;
  /** The last number given to a command or an ask, in the order they were sent. */
  seq: number;
  life: Life;
  hold: Hold;
  drive: Drive;
  watch: Watch;
  capabilities: Capabilities;
}

interface Done {
  status: 'done';
}

interface Failed {
  status: 'failed';
  /** What the camera's driver threw. */
  error: unknown;
}

interface TurnedAway {
  status: 'held';
}

interface Gone {
  status: 'gone';
}

/** How a command came out: carried out, failed at the camera, turned away for the hold, or the camera let go of. */
export type Outcome = Done | Failed | TurnedAway | Gone;

/** A command's kind. */
type Kind = CameraCommand['kind'];

/** Something that happened at a time, epoch milliseconds, and nothing more. */
export interface AtEvent {
  at: number;
}

export interface CommandedEvent extends AtEvent {
  /** The command's own ID, which `settled` names it by. */
  id: string;
  command: CameraCommand;
  /** The endpoint ID of the device that sent it. */
  peer: string;
  priority: CameraGrantPriority;
}

export interface CommandSettledEvent extends AtEvent {
  id: string;
  /** Its number, in the order commands were sent. */
  seq: number;
  kind: Kind;
}

export interface CommandFailedEvent extends CommandSettledEvent {
  error: unknown;
}

export interface HaltEvent extends AtEvent {
  /** The stop's number, in the order commands were sent. */
  seq: number;
}

export interface HaltFailedEvent extends HaltEvent {
  error: unknown;
}

export interface AnsweredEvent extends AtEvent {
  /** The ask it answers. */
  seq: number;
  position: CameraPosition;
  /** Undefined when they weren't asked for. */
  options: CameraOptionValues | undefined;
}

export interface UnansweredEvent extends AtEvent {
  /** The ask that went unanswered. */
  seq: number;
}

export interface CapabilitiesAnsweredEvent extends AtEvent {
  capabilities: CameraCapabilities;
}

export interface CapabilitiesUnansweredEvent extends AtEvent {
  error: unknown;
}

export type CameraEvents = {
  /** A command its grant admits is sent to the camera: `settled` says how it came out. */
  commanded: CommandedEvent;
  /** The camera carried out a command. */
  commandSucceeded: CommandSettledEvent;
  /** The camera didn't carry out a command, or didn't say it had in time. */
  commandFailed: CommandFailedEvent;
  /** The drive's deadline came. */
  deadlinePassed: AtEvent;
  /** The camera took the agent's own stop. */
  haltSucceeded: HaltEvent;
  /** The camera didn't take the agent's own stop, or didn't say it had in time. */
  haltFailed: HaltFailedEvent;
  /** The hold's time came. */
  holdLapsed: AtEvent;
  /** Someone starts watching the camera. */
  watcherJoined: AtEvent;
  /** Someone stops watching it. */
  watcherLeft: AtEvent;
  /** The watch's rest came to its end. */
  restEnded: AtEvent;
  /** The camera said where it points, and what its options are set to when it was asked that too. */
  answered: AnsweredEvent;
  /** The camera didn't say where it points. */
  unanswered: UnansweredEvent;
  /** What the camera can do is wanted. */
  capabilitiesWanted: AtEvent;
  /** The camera said what it can do. */
  capabilitiesAnswered: CapabilitiesAnsweredEvent;
  /** The camera didn't say what it can do. */
  capabilitiesUnanswered: CapabilitiesUnansweredEvent;
  /** The camera is no longer controlled here: it is stopped if it may be moving, and forgotten. */
  released: AtEvent;
  /** Everything stops now, the camera with nothing more said to it. */
  disposed: AtEvent;
  /** It may be moving on a drive given under the registration this one replaces, whose stop it didn't take. */
  adopted: AtEvent;
};

export interface SettledEvent {
  /** The command's own ID. */
  id: string;
  outcome: Outcome;
}

export type CameraEmitted = {
  /** How a command came out. */
  settled: SettledEvent;
  /** The camera is no longer controlled here: its watchers are done. */
  ended: AtEvent;
};

/** What the store's effects reach: the camera, the time, and what calls off what is asked of the camera. */
export interface CameraIO {
  driver: CameraDriver;
  time: Time;
  /** Aborts the reads (asks, and what the camera can do) when the camera is let go of. */
  reads: AbortSignal;
  /** Aborts everything, commands and stops too, when the control is disposed of. */
  ends: AbortSignal;
}

type Enqueue = EnqueueObject<CameraContext, ExtractEvents<CameraEmitted>, CameraEvents>;

export type CameraStore = Store<CameraContext, CameraEvents, ExtractEvents<CameraEmitted>>;

const CONTROLLED: Life = { status: 'controlled' };
const RELEASED: Life = { status: 'released', moving: false };
const LEFT_MOVING: Life = { status: 'released', moving: true };
const FREE: Hold = { status: 'free' };
const IDLE: Drive = { status: 'idle' };
const UNWATCHED: Watch = { status: 'unwatched' };
const UNKNOWN: Capabilities = { status: 'unknown' };
const DONE: Outcome = { status: 'done' };
const HELD: Outcome = { status: 'held' };
const GONE: Outcome = { status: 'gone' };

/** A camera's context when it is first controlled. */
export function initialCamera(id: string): CameraContext {
  return { id, seq: 0, life: CONTROLLED, hold: FREE, drive: IDLE, watch: UNWATCHED, capabilities: UNKNOWN };
}

/** Whether a command from this peer, at this priority, is turned away for someone else holding the camera at `at`. */
export function heldAgainst(hold: Hold, peer: string, priority: CameraGrantPriority, at: number): boolean {
  if (priority === 'operator' || hold.status === 'free') return false;
  return hold.until > at && hold.peer !== peer;
}

/** The hold as it stands at `at`: one whose time has come is over, even if its event hasn't come yet. */
function standing(hold: Hold, at: number): Hold {
  return hold.status === 'held' && hold.until <= at ? FREE : hold;
}

/** The holder as the camera's state says it. */
export function holderOf(hold: Hold): CameraHolder | null {
  if (hold.status === 'free') return null;
  const expiresAt = new Date(hold.until).toISOString();
  return { peer: hold.peer, expiresAt };
}

/** The camera's state from what it said, and who holds it. */
export function stateOf(position: CameraPosition, options: CameraOptionValues, hold: Hold, at: number) {
  const holder = holderOf(hold);
  const observedAt = new Date(at).toISOString();
  return { position, options, holder, observedAt } satisfies CameraControlState;
}

/** What of a state is news when it changes: everything but the times. */
function saidOf(state: CameraControlState | undefined): string {
  if (state === undefined) return '';
  return JSON.stringify([state.position, state.options, state.holder?.peer]);
}

/** The state told to whoever watches the camera, if anyone does and it has answered. */
export function toldOf(context: CameraContext): CameraControlState | undefined {
  return context.watch.status === 'unwatched' ? undefined : context.watch.told;
}

/** The context with the told state's holder brought up to date, when the holder changed: told at once. */
function retold(context: CameraContext): CameraContext {
  const { watch, hold } = context;
  if (watch.status === 'unwatched' || watch.told === undefined) return context;
  const holder = holderOf(hold);
  const was = watch.told.holder?.peer ?? null;
  if (was === (holder?.peer ?? null)) return context;
  const told = { ...watch.told, holder };
  return { ...context, watch: { ...watch, told } };
}

/** The drive after a drive's answer, either way: the latest drive's answer sets the deadline from now. */
function quieted(drive: Drive, seq: number, at: number): Drive {
  if (drive.status !== 'driving' || drive.since !== seq) return drive;
  return { status: 'driving', since: seq, deadline: at + DRIVE_TIMEOUT_MS };
}

/** The drive after the camera took a move or a stop: idle, if it was sent after the drive (or the stop). */
function replaced(drive: Drive, seq: number): Drive {
  if (drive.status === 'driving' && seq > drive.since) return IDLE;
  if (drive.status === 'stopping' && seq > drive.seq) return IDLE;
  return drive;
}

/** How long the watch rests between asks: less while the camera may be moving. */
function restOf(drive: Drive): number {
  return drive.status === 'idle' ? WATCH_INTERVAL_MS : DRIVEN_INTERVAL_MS;
}

/** What the store is to be woken for, and when (epoch milliseconds), as its state says. */
export interface CameraAlarms {
  /** The hold's end: `holdLapsed`. */
  hold?: number;
  /** The drive's deadline: `deadlinePassed`. */
  drive?: number;
  /** The watch's rest's end: `restEnded`. */
  watch?: number;
}

export function alarmsOf(context: CameraContext): CameraAlarms {
  const { hold, drive, watch } = context;
  const alarms: CameraAlarms = {};
  if (hold.status === 'held') alarms.hold = hold.until;
  if (drive.status === 'driving') alarms.drive = drive.deadline;
  if (watch.status === 'resting') alarms.watch = watch.since + restOf(drive);
  return alarms;
}

/** Run `work` with a signal that aborts after `ms`, or when `also` does. */
function within<T>(time: Time, ms: number, also: AbortSignal, work: (signal: AbortSignal) => Promise<T>) {
  return withinTime(time, ms, also, work, 'The camera took too long');
}

/** Send the command to the camera. */
function carry(driver: CameraDriver, command: CameraCommand, signal: AbortSignal): Promise<void> {
  switch (command.kind) {
    case 'moveTo':
      return driver.moveTo(command, signal);
    case 'moveBy':
      return driver.moveBy(command, signal);
    case 'moveToPoint':
      return driver.moveToPoint(command, signal);
    case 'moveToRegion':
      return driver.moveToRegion(command, signal);
    case 'drive':
      return driver.drive(command, signal);
    case 'stop':
      return driver.stop(signal);
    case 'configure':
      return driver.configure(command.key, command.value, signal);
    case 'run':
      return driver.run(command.action, signal);
  }
}

/** One camera's store, its effects reaching the camera through `io`. */
export function cameraStore(id: string, io: CameraIO): CameraStore {
  const { driver, time, reads, ends } = io;

  /** Have the camera stopped on the agent's own account, as command `seq`. */
  function halt(seq: number, enq: Enqueue): void {
    enq.effect(({ trigger }) => {
      const stopped = within(time, CAMERA_TIMEOUT_MS, ends, signal => driver.stop(signal));
      void stopped.then(
        () => trigger.haltSucceeded({ seq, at: time.now() }),
        error => trigger.haltFailed({ seq, error, at: time.now() })
      );
    });
  }

  /** Ask the camera where it points, and its options too when it is time to or `refresh` says so. */
  function ask(context: CameraContext, watching: Watching, refresh: boolean, enq: Enqueue): CameraContext {
    const seq = context.seq + 1;
    const readOptions = refresh || watching.asks % OPTIONS_EVERY === 0;
    enq.effect(({ trigger }) => {
      const read = within(time, CAMERA_TIMEOUT_MS, reads, async signal => {
        const options = readOptions ? await driver.options(signal) : undefined;
        const position = await driver.position(signal);
        return { position, options };
      });
      void read.then(
        ({ position, options }) => trigger.answered({ seq, position, options, at: time.now() }),
        () => trigger.unanswered({ seq, at: time.now() })
      );
    });
    const { watchers, asks, options, told } = watching;
    const watch: Asking = { status: 'asking', watchers, asks: asks + 1, options, told, seq, stale: false };
    return { ...context, seq, watch };
  }

  /** The watch after an ask came back: rest, or ask again at once if a command was carried out meanwhile. */
  function asked(
    context: CameraContext,
    watch: Asking,
    told: CameraControlState | undefined,
    at: number,
    enq: Enqueue
  ) {
    const { watchers, asks, options } = watch;
    if (watch.stale) return ask(context, { watchers, asks, options, told }, true, enq);
    const resting: Resting = { status: 'resting', watchers, asks, options, told, since: at };
    return { ...context, watch: resting };
  }

  /** The watch after a command was carried out: the camera asked again at once, its options too. */
  function refreshed(context: CameraContext, enq: Enqueue): CameraContext {
    const { watch } = context;
    if (watch.status === 'unwatched') return context;
    if (watch.status === 'asking') return { ...context, watch: { ...watch, stale: true } };
    return ask(context, watch, true, enq);
  }

  return createStore<CameraContext, CameraEvents, CameraEmitted>({
    context: initialCamera(id),
    on: {
      commanded: (context, event, enq) => {
        const { id: commandId, command, peer, priority, at } = event;
        if (context.life.status !== 'controlled') {
          enq.emit.settled({ id: commandId, outcome: GONE });
          return context;
        }
        if (heldAgainst(context.hold, peer, priority, at)) {
          enq.emit.settled({ id: commandId, outcome: HELD });
          return context;
        }
        const seq = context.seq + 1;
        const { kind } = command;
        const now = standing(context.hold, at);
        const hold: Hold = priority === 'operator' ? { status: 'held', peer, until: at + HOLD_MS } : now;
        // A drive may reach the camera however it is answered, so it has a stop coming from the moment it is sent:
        // far enough off to cover its answer, which brings the stop nearer.
        const deadline = at + CAMERA_TIMEOUT_MS + DRIVE_TIMEOUT_MS;
        const drive: Drive = kind === 'drive' ? { status: 'driving', since: seq, deadline } : context.drive;
        enq.effect(({ trigger }) => {
          const carried = within(time, CAMERA_TIMEOUT_MS, ends, signal => carry(driver, command, signal));
          void carried.then(
            () => trigger.commandSucceeded({ id: commandId, seq, kind, at: time.now() }),
            error => trigger.commandFailed({ id: commandId, seq, kind, error, at: time.now() })
          );
        });
        return retold({ ...context, seq, hold, drive });
      },
      commandSucceeded: (context, event, enq) => {
        const { id: commandId, seq, kind, at } = event;
        enq.emit.settled({ id: commandId, outcome: DONE });
        if (context.life.status !== 'controlled') return context;
        if (kind === 'drive') return { ...context, drive: quieted(context.drive, seq, at) };
        // Whoever follows the camera hears what the command changed at once, not at the watch's next turn. A `drive`
        // is repeated many times a second, and the camera's position as it moves is told by the watch's own pace.
        // Setting an option or running an action doesn't stop a camera that is turning: only a move or a stop does.
        const moved = kind !== 'configure' && kind !== 'run';
        const drive = moved ? replaced(context.drive, seq) : context.drive;
        return refreshed({ ...context, drive }, enq);
      },
      commandFailed: (context, event, enq) => {
        const { id: commandId, seq, kind, error, at } = event;
        enq.emit.settled({ id: commandId, outcome: { status: 'failed', error } });
        if (context.life.status !== 'controlled' || kind !== 'drive') return context;
        return { ...context, drive: quieted(context.drive, seq, at) };
      },
      deadlinePassed: (context, event, enq) => {
        const { drive, life } = context;
        if (life.status !== 'controlled' || drive.status !== 'driving' || drive.deadline > event.at) return context;
        const seq = context.seq + 1;
        halt(seq, enq);
        return { ...context, seq, drive: { status: 'stopping', seq } };
      },
      // The stop the camera was let go with ends the release; the one its deadline sent ends the drive, unless a drive
      // was sent after it. Any other stop's answer is stale.
      haltSucceeded: (context, event) => {
        const { drive, life } = context;
        if (life.status === 'releasing' && life.seq === event.seq) return { ...context, life: RELEASED };
        if (drive.status !== 'stopping' || drive.seq !== event.seq) return context;
        return { ...context, drive: IDLE };
      },
      haltFailed: (context, event, enq) => {
        const { seq, error, at } = event;
        const { drive, life } = context;
        const mine =
          (life.status === 'releasing' && life.seq === seq) || (drive.status === 'stopping' && drive.seq === seq);
        if (!mine) return context;
        enq.effect(() => logger.error('Camera {cameraId} could not be stopped: {error}', { cameraId: id, error }));
        if (life.status === 'releasing') return { ...context, life: LEFT_MOVING };
        // A stop the camera didn't take leaves it as it was after the drive: stopped again at the next deadline.
        return { ...context, drive: { status: 'driving', since: seq, deadline: at + DRIVE_TIMEOUT_MS } };
      },
      holdLapsed: (context, event) => {
        const hold = standing(context.hold, event.at);
        if (hold === context.hold) return context;
        return retold({ ...context, hold });
      },
      watcherJoined: (context, _event, enq) => {
        const { watch, life } = context;
        if (life.status !== 'controlled') return context;
        if (watch.status !== 'unwatched') return { ...context, watch: { ...watch, watchers: watch.watchers + 1 } };
        return ask(context, { watchers: 1, asks: 0, options: {}, told: undefined }, false, enq);
      },
      watcherLeft: context => {
        const { watch } = context;
        if (watch.status === 'unwatched') return context;
        if (watch.watchers > 1) return { ...context, watch: { ...watch, watchers: watch.watchers - 1 } };
        return { ...context, watch: UNWATCHED };
      },
      restEnded: (context, event, enq) => {
        const { watch, drive } = context;
        if (watch.status !== 'resting' || watch.since + restOf(drive) > event.at) return context;
        return ask(context, watch, false, enq);
      },
      // The answer to the ask in hand, and only that one: the state it makes is told if it is news, and the hold is
      // brought up to the answer's time first, so a hold that has just ended is not told as standing.
      answered: (context, event, enq) => {
        const { seq, position, at } = event;
        const { watch } = context;
        if (watch.status !== 'asking' || watch.seq !== seq) return context;
        const hold = standing(context.hold, at);
        const options = event.options ?? watch.options;
        const state = stateOf(position, options, hold, at);
        const news = saidOf(state) !== saidOf(watch.told);
        const told = news ? state : watch.told;
        const next = asked({ ...context, hold }, { ...watch, options }, told, at, enq);
        return retold(next);
      },
      unanswered: (context, event, enq) => {
        // A camera that doesn't answer has no state to tell: it is asked again, and probes say it is unreachable.
        const { watch } = context;
        if (watch.status !== 'asking' || watch.seq !== event.seq) return context;
        return asked(context, watch, watch.told, event.at, enq);
      },
      capabilitiesWanted: (context, _event, enq) => {
        if (context.life.status !== 'controlled' || context.capabilities.status !== 'unknown') return context;
        enq.effect(({ trigger }) => {
          const asked = within(time, CAMERA_TIMEOUT_MS, reads, signal => driver.capabilities(signal));
          void asked.then(
            capabilities => trigger.capabilitiesAnswered({ capabilities, at: time.now() }),
            error => trigger.capabilitiesUnanswered({ error, at: time.now() })
          );
        });
        return { ...context, capabilities: { status: 'asking' } };
      },
      capabilitiesAnswered: (context, event) => {
        if (context.capabilities.status !== 'asking') return context;
        return { ...context, capabilities: { status: 'known', capabilities: event.capabilities } };
      },
      capabilitiesUnanswered: (context, event, enq) => {
        if (context.capabilities.status !== 'asking') return context;
        const { error } = event;
        enq.effect(() => logger.warn('Camera {cameraId} did not say what it can do: {error}', { cameraId: id, error }));
        return { ...context, capabilities: UNKNOWN };
      },
      released: (context, event, enq) => {
        const { drive, life } = context;
        if (life.status !== 'controlled') return context;
        enq.emit.ended({ at: event.at });
        const capabilities = context.capabilities.status === 'asking' ? UNKNOWN : context.capabilities;
        const forgotten = { ...context, hold: FREE, drive: IDLE, watch: UNWATCHED, capabilities };
        if (drive.status === 'idle') return { ...forgotten, life: RELEASED };
        // A stop already on its way is the one it is let go with; otherwise one is sent now.
        if (drive.status === 'stopping') return { ...forgotten, life: { status: 'releasing', seq: drive.seq } };
        const seq = context.seq + 1;
        halt(seq, enq);
        return { ...forgotten, seq, life: { status: 'releasing', seq } };
      },
      adopted: (context, event) => {
        // Stopped at once, as a drive whose deadline has come: by this registration's driver, which may reach it
        // where the last one didn't. Anything it is told meanwhile replaces it, as it would a drive.
        if (context.life.status !== 'controlled' || context.drive.status !== 'idle') return context;
        return { ...context, drive: { status: 'driving', since: context.seq, deadline: event.at } };
      },
      disposed: (context, event, enq) => {
        if (context.life.status === 'controlled') enq.emit.ended({ at: event.at });
        const capabilities = context.capabilities.status === 'asking' ? UNKNOWN : context.capabilities;
        const life: Life = { status: 'released', moving: context.drive.status !== 'idle' };
        return { ...context, life, hold: FREE, drive: IDLE, watch: UNWATCHED, capabilities };
      }
    }
  });
}

/** The context once it satisfies `done`: at once if it already does. */
export function until(store: CameraStore, done: (context: CameraContext) => boolean): Promise<CameraContext> {
  const snapshot = store.getSnapshot();
  if (done(snapshot.context)) return Promise.resolve(snapshot.context);
  return new Promise(resolve => {
    const following = store.subscribe(next => {
      if (!done(next.context)) return;
      following.unsubscribe();
      resolve(next.context);
    });
  });
}

/** How command `id` comes out, once it is sent: to be called before it is sent, since a refusal is told at once. */
export function settlement(store: CameraStore, id: string): Promise<Outcome> {
  return new Promise(resolve => {
    const following = store.on('settled', settled => {
      if (settled.id !== id) return;
      following.unsubscribe();
      resolve(settled.outcome);
    });
  });
}

type AlarmName = keyof CameraAlarms;

const ALARM_NAMES: AlarmName[] = ['hold', 'drive', 'watch'];

/** The event each alarm wakes the store with. */
const RINGS = { hold: 'holdLapsed', drive: 'deadlinePassed', watch: 'restEnded' } as const;

/**
 * The timers a camera's store is woken by, kept to what its state says (`alarmsOf`) each time it changes: an alarm
 * the state no longer wants is cancelled, and one at a new time set for it. They are the store's only timers.
 */
export class Alarms extends StateAlarms<AlarmName> {
  constructor(store: CameraStore, time: Time) {
    super(
      time,
      () => wantedOf(store),
      (name, at) => store.send({ type: RINGS[name], at })
    );
  }
}

/** The alarms the store's state wants, by name. */
function wantedOf(store: CameraStore): Map<AlarmName, number> {
  const snapshot = store.getSnapshot();
  const alarms = alarmsOf(snapshot.context);
  const wanted = new Map<AlarmName, number>();
  for (const name of ALARM_NAMES) {
    const at = alarms[name];
    if (at !== undefined) wanted.set(name, at);
  }
  return wanted;
}

/** The grants for one command already used, by ID, each until it would have expired anyway. */
export interface LedgerContext {
  used: Record<string, number>;
}

export interface SpentEvent extends AtEvent {
  /** The grant's ID. */
  id: string;
  /** Epoch milliseconds: when the grant expires, and need no longer be remembered. */
  expiresAt: number;
}

export type LedgerEvents = {
  /** A grant for one command is used, at `at`: those that have expired by then are forgotten. */
  spent: SpentEvent;
  /** Every grant is forgotten: the cameras are no longer controlled here. */
  cleared: AtEvent;
};

/** The ledger emits nothing. */
type LedgerEmitted = Record<never, never>;

/** Whether a grant for one command has been used, as of `at`. */
export function spentAlready(ledger: LedgerContext, id: string, at: number): boolean {
  const expiresAt = ledger.used[id];
  return expiresAt !== undefined && expiresAt > at;
}

export function ledgerStore() {
  return createStore<LedgerContext, LedgerEvents, LedgerEmitted>({
    context: { used: {} },
    on: {
      spent: (context, event) => {
        const { id, expiresAt, at } = event;
        const entries = Object.entries(context.used);
        const live = entries.filter(([, until]) => until > at);
        const used = Object.fromEntries(live);
        used[id] = expiresAt;
        return { used };
      },
      cleared: () => ({ used: {} })
    }
  });
}

export type LedgerStore = ReturnType<typeof ledgerStore>;
