import { createContext, use } from 'react';
import type { State } from '@conservationtv/agent-sdk';
import type { CameraCommand, CameraPosition } from '@conservationtv/cameras';
import { createStore, type EnqueueObject, type TriggerObject } from '@xstate/store';
import { useSelector } from '@xstate/store-react';

import { namedTasks, realClock, type CameraClock } from '@/components/cameras/control/store/camera-tasks';
import type { CameraControlSession } from '@/queries/camera-control';

// What this browser knows of the camera it is controlling, and what it is doing about it, in one place: one store per
// control session (camera-control.tsx). Three machines share it, and each moves only by the events below:
//
//   link    following the agent's event stream (camera-stream.ts reads it). The agent sends the camera's state at once
//           and on every change, a ping when nothing has changed for fifteen seconds, and ends the stream after ten
//           minutes. Anything it sends is proof the stream is alive; nothing for three heartbeats and the stream is
//           taken for stalled, let go, and asked for again. Its last word is `reported`, kept while the link is down.
//   lock    whether this browser sends the camera anything: not while another device holds it, until whoever is at
//           the controls here takes it over. The lock is this browser's own manners, not the agent's rule: the agent
//           lets any person at the controls take the camera from another.
//   claim   what this browser has asked for that the agent hasn't said yet. The parts show the agent's word with the
//           claims over it, so a control shows what was asked for from the moment it is asked, and never falls back
//           to the old value in the gap between the camera taking a command and the agent's stream saying so.
//
// A command goes in as one event, `commanded`, and that one event does all of it: refuses the command while the camera
// is locked, gives up the zoom's claim for a stop or a drive that moves the zoom, claims what the command changes, and sends it, as an
// effect, through the session as it is then (a renewed grant keeps the same store going, `renewed`). The send's
// outcome comes back as `taken` or `refused`; a taken claim waits for the agent on a timer that ends in `settled`.
//
// The stream and the timers are effects, each kept under a name so that a later event can call it off: arming one
// replaces whatever was armed under its name, and `stopped` calls off all of them. Which stream an event came from is
// part of it, so anything a let-go stream still says is ignored. Time is the clock the store is made with: the real
// one, or a fake one to drive the store by hand.
//
//   link     idle ── started ──▶ connecting ─┐
//                                            │ heard: a state, a ping, anything
//                                            ▼
//            ┌─────── heard ─────────────▶ live ◀──────────── heard ──────────────────┐
//            │                              │                                         │
//            │                              ├── ended ──▶ reconnecting·waiting ── waited (1 s) ──▶ reconnecting·asking
//            │                              ├── failed ─▶ lost·waiting ───────── waited (5 s) ──▶ lost·asking
//            │                              └── silent (45 s of nothing) ──▶ stale (asks again at once)
//            │                                                                        │
//            └── stale, reconnecting·asking and lost·asking each have a stream open ──┘
//
//            From any state with a stream open (connecting, live, stale, ·asking), the same four: heard ─▶ live,
//            ended ─▶ reconnecting·waiting, failed ─▶ lost·waiting, silent ─▶ stale. A grant renewed through another
//            agent lets go of an open stream and asks the new one: connecting. From any state: stopped ─▶ idle.
//
//   lock     free ── another holds ──▶ locked ── tookOver ──▶ overridden
//             ▲  ▲                      │   ▲                    │  │
//             │  └── nobody, or self ───┘   └── a third holds ───┘  │
//             └────────────────────────── nobody holds ─────────────┘
//
//            Reports only move the lock (tookOver aside), and only by who holds the camera. Locked stays locked while
//            another device holds it, by whichever that is now; overridden stays overridden while this browser or the
//            device taken over from holds it. The lock is free until the agent's first word.
//
//   claim    commanded ──▶ sending ── taken ──▶ awaiting ── reported and agreeing, or settled (8 s) ──▶ gone
//            (unless locked)  │  └── taken, and the agent already agrees ───────────────────────────────▶ gone
//                             └── refused ───────────────────────────────────────────────────────────────▶ gone
//
//            From either: a later claim to the same thing, a stop or a zooming drive (for the zoom's), or stopped ─▶ gone.
//            At most one claim for each option and one for zoom.

/** What a camera's agent says of it: where it points, what its options are set to, and who holds it. */
export type CameraReport = State;

/** How long after a stream ends as it should the next is asked for. */
const RECONNECT_MS = 1_000;
/** How long after a stream fails it is tried again: its agent may be off, or no longer the camera's. */
const RETRY_MS = 5_000;
/**
 * How long a stream may say nothing before it is taken for stalled: three of the agent's fifteen-second heartbeats,
 * so one slow ping is never enough.
 */
const SILENCE_MS = 45_000;
/**
 * How long the agent has to say what a command changed before this browser stops showing what it asked for. An agent
 * reads its camera's options again every five seconds.
 */
const SETTLE_MS = 8_000;

/** Not following the stream: before the session starts, and after it stops. */
interface LinkIdle {
  status: 'idle';
}

/** Asking for the first stream of a following, or of a new agent's: nothing heard on it yet. */
interface LinkConnecting {
  status: 'connecting';
  stream: number;
}

/** Heard from on this stream within `SILENCE_MS`. */
interface LinkLive {
  status: 'live';
  stream: number;
}

/** The last stream ended as it should: waiting a moment, then asking for the next. */
interface LinkReconnecting {
  status: 'reconnecting';
  retry: LinkRetry;
}

/** The last stream said nothing for `SILENCE_MS`: it was let go, and this one asked for in its place. */
interface LinkStale {
  status: 'stale';
  stream: number;
}

/** The last stream failed: waiting a little, then trying again. */
interface LinkLost {
  status: 'lost';
  /** Why the stream couldn't be followed. */
  failure: string;
  retry: LinkRetry;
}

/** Waiting before asking for another stream. */
interface RetryWaiting {
  phase: 'waiting';
}

/** Asking for another stream, open as `stream`: nothing heard on it yet. */
interface RetryAsking {
  phase: 'asking';
  stream: number;
}

/** Where a link that is down is in coming back. */
type LinkRetry = RetryWaiting | RetryAsking;

/** Whether the agent's stream is being followed, and how that is going. */
export type CameraLink = LinkIdle | LinkConnecting | LinkLive | LinkReconnecting | LinkStale | LinkLost;

const IDLE: CameraLink = { status: 'idle' };
const WAITING: LinkRetry = { phase: 'waiting' };

/** Free to move from here: nobody else holds the camera, or nobody is known to. */
interface LockFree {
  status: 'free';
}

/** Another device holds the camera: nothing is sent to it from here. */
interface LockLocked {
  status: 'locked';
  /** The public ID of the device that holds it. */
  peer: string;
}

/** Taken over from the device that held the camera: it no longer locks it, until nobody holds it or a third device does. */
interface LockOverridden {
  status: 'overridden';
  /** The device it was taken over from. */
  peer: string;
}

/** Whether the camera is locked to this browser by another device. */
export type CameraLock = LockFree | LockLocked | LockOverridden;

const FREE: CameraLock = { status: 'free' };

/** One of the camera's options, set to a value. */
interface OptionChange {
  kind: 'option';
  key: string;
  value: string;
}

/** The camera's zoom, sent to a place in its range, 0 to 1. The camera takes a while to get there. */
interface ZoomChange {
  kind: 'zoom';
  zoom: number;
}

/** What a command changes that the agent reports. */
export type CameraChange = OptionChange | ZoomChange;

/** A change this browser asked for: being sent, or taken by the camera and waiting for the agent to say so. */
interface CameraClaim {
  /** Which command it came from. */
  id: number;
  change: CameraChange;
  phase: 'sending' | 'awaiting';
}

/** How near the zoom the agent reports is to the one asked for to count as there. */
const ZOOM_NEAR = 0.02;

export interface CameraState {
  /** This browser's device's public ID, as the agent names it while it holds the camera. Fixed for the session. */
  self: string;
  /** What commands and streams go through: the grant as it is now, renewed while the session lasts. */
  session: CameraControlSession;
  link: CameraLink;
  /** The agent's last word. Undefined until its first; kept while the link is down, as the last that was known. */
  reported: CameraReport | undefined;
  lock: CameraLock;
  /** What this browser has asked for that the agent hasn't said yet, at most one for each option and one for zoom. */
  claims: CameraClaim[];
  /** The last stream asked for, by number: an event from any other is from one already let go. */
  streams: number;
  /** The last claim made, by number. */
  commands: number;
}

/** Something the agent's stream carried: the camera's state, or anything else, which only says it is alive. */
export type CameraHeard = HeardState | HeardSign;

interface HeardState {
  kind: 'state';
  report: CameraReport;
}

interface HeardSign {
  kind: 'sign';
}

/** What the store asks of the camera's agent: to run a command, and to stream the camera's state. */
export interface CameraAgent {
  /** Send one command through a session. Rejects, in words for whoever is at the controls, if it isn't taken. */
  send: (session: CameraControlSession, command: CameraCommand) => Promise<void>;
  /** The camera's stream through a session's agent, until it ends, fails, or the signal lets go of it. */
  listen: (session: CameraControlSession, signal: AbortSignal) => AsyncIterable<CameraHeard>;
}

export type { CameraClock };

export interface CameraStoreOptions {
  /** The session's first grant. */
  session: CameraControlSession;
  agent: CameraAgent;
  /** The real clock unless another is given. */
  clock?: CameraClock;
}

/** How a command's sender hears how it went. */
export interface CommandReply {
  resolve: () => void;
  reject: (reason: Error) => void;
}

interface CommandedEvent {
  command: CameraCommand;
  reply: CommandReply;
}

interface RenewedEvent {
  session: CameraControlSession;
}

interface StreamEvent {
  stream: number;
}

interface ReportedEvent extends StreamEvent {
  report: CameraReport;
}

interface FailedEvent extends StreamEvent {
  failure: string;
}

interface TookOverEvent {
  /** The device the camera is taken over from. */
  peer: string;
}

interface ClaimEvent {
  id: number;
}

type NoPayload = Record<never, never>;

/** Every event the store takes, by name. Each is described where it is handled, in `createCameraStore`. */
type CameraEvents = {
  started: NoPayload;
  stopped: NoPayload;
  renewed: RenewedEvent;
  reported: ReportedEvent;
  pinged: StreamEvent;
  ended: StreamEvent;
  failed: FailedEvent;
  silent: StreamEvent;
  waited: NoPayload;
  tookOver: TookOverEvent;
  commanded: CommandedEvent;
  taken: ClaimEvent;
  refused: ClaimEvent;
  settled: ClaimEvent;
};

type CameraEnqueue = EnqueueObject<CameraState, never, CameraEvents>;
type CameraTrigger = TriggerObject<CameraEvents>;

/** What a change is a change to, as one word: a later claim to the same thing replaces an earlier one. */
const subjectOf = (change: CameraChange) => (change.kind === 'zoom' ? 'zoom' : `option:${change.key}`);

/** Whether the agent's word is what a change asked for. */
function agrees(report: CameraReport | undefined, change: CameraChange): boolean {
  if (report === undefined) return false;
  if (change.kind === 'option') return report.options[change.key] === change.value;
  const zoom = report.position.zoom;
  return zoom !== undefined && Math.abs(zoom - change.zoom) <= ZOOM_NEAR;
}

/** What a command changes that the agent reports, if anything: only then does sending it make a claim. */
function changeOf(command: CameraCommand): CameraChange | undefined {
  if (command.kind === 'configure') return { kind: 'option', key: command.key, value: command.value };
  if (command.kind === 'moveTo' && command.zoom !== undefined) return { kind: 'zoom', zoom: command.zoom };
  return undefined;
}

/** The stream the link has open, by number, if it has one: only events from it are heard. */
function openStreamOf(link: CameraLink): number | undefined {
  if (link.status === 'connecting' || link.status === 'live' || link.status === 'stale') return link.stream;
  if (link.status === 'reconnecting' || link.status === 'lost') {
    return link.retry.phase === 'asking' ? link.retry.stream : undefined;
  }
  return undefined;
}

/**
 * The lock, once the agent says who holds the camera. Nobody frees it, and so ends a take-over; this browser frees a
 * lock, but a take-over lasts while it holds the camera, as it does while the device taken over from still does.
 * Anyone else locks it.
 */
function lockAfter(lock: CameraLock, holder: string | null, self: string): CameraLock {
  if (holder === null) return FREE;
  if (lock.status !== 'free' && lock.peer === holder) return lock;
  if (holder === self) return lock.status === 'overridden' ? lock : FREE;
  return { status: 'locked', peer: holder };
}

/** The timers and the stream, by the names they are kept under. A claim's timer is named for its command. */
const STREAM = 'stream';
const SILENCE = 'silence';
const PAUSE = 'pause';
const settlingOf = (id: number) => `settle:${id}`;

/**
 * Read one stream to its end, telling the store what it carries, and how it ended, as from `stream`. Nothing is told
 * once the signal has let go of it.
 */
async function follow(
  agent: CameraAgent,
  session: CameraControlSession,
  stream: number,
  trigger: CameraTrigger,
  signal: AbortSignal
): Promise<void> {
  try {
    for await (const heard of agent.listen(session, signal)) {
      if (signal.aborted) return;
      if (heard.kind === 'state') trigger.reported({ stream, report: heard.report });
      else trigger.pinged({ stream });
    }
  } catch (error) {
    // Letting go aborts the request and cancels its body, either of which may reject: that is not a failure to tell.
    if (!signal.aborted) trigger.failed({ stream, failure: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (!signal.aborted) trigger.ended({ stream });
}

/** Send a command, telling its sender how it went, and the store too when it made a claim. */
async function deliver(
  agent: CameraAgent,
  session: CameraControlSession,
  command: CameraCommand,
  reply: CommandReply,
  told: ClaimOutcome | undefined
): Promise<void> {
  try {
    await agent.send(session, command);
  } catch (error) {
    told?.refused();
    reply.reject(error instanceof Error ? error : new Error(String(error)));
    return;
  }
  told?.taken();
  reply.resolve();
}

/** How the store hears what became of a claimed command. */
interface ClaimOutcome {
  taken: () => void;
  refused: () => void;
}

/** The store of one control session. Its `run` is `runCommand`. */
export function createCameraStore(options: CameraStoreOptions) {
  const agent = options.agent;
  const clock = options.clock ?? realClock;
  const tasks = namedTasks();

  /** Arm the timer called `name`, in place of any armed under it, to fire after `milliseconds`. */
  const arm = (enq: CameraEnqueue, name: string, milliseconds: number, fire: (trigger: CameraTrigger) => void) => {
    enq.effect(({ trigger }) => {
      tasks.start(name, () =>
        clock(milliseconds, () => {
          tasks.stop(name);
          fire(trigger);
        })
      );
    });
  };

  /** Call off the timer or stream called `name`. */
  const disarm = (enq: CameraEnqueue, name: string) => enq.effect(() => tasks.stop(name));

  /**
   * Ask for a new stream through the session as it is, letting go of any open: the link is `asking` with its number,
   * and the stream has `SILENCE_MS` to say something.
   */
  const ask = (state: CameraState, enq: CameraEnqueue, asking: (stream: number) => CameraLink): CameraState => {
    const stream = state.streams + 1;
    const session = state.session;
    enq.effect(({ trigger }) => {
      tasks.start(STREAM, () => {
        const following = new AbortController();
        void follow(agent, session, stream, trigger, following.signal);
        return () => following.abort();
      });
    });
    arm(enq, SILENCE, SILENCE_MS, trigger => trigger.silent({ stream }));
    return { ...state, streams: stream, link: asking(stream) };
  };

  /** The stream is over: the link is down, as `link`, and waits `milliseconds` before asking again. */
  const pause = (state: CameraState, enq: CameraEnqueue, link: CameraLink, milliseconds: number): CameraState => {
    disarm(enq, STREAM);
    disarm(enq, SILENCE);
    arm(enq, PAUSE, milliseconds, trigger => trigger.waited());
    return { ...state, link };
  };

  /** Something was heard on the open stream: it is live, and has `SILENCE_MS` again. */
  const hear = (state: CameraState, enq: CameraEnqueue, stream: number): CameraState => {
    arm(enq, SILENCE, SILENCE_MS, trigger => trigger.silent({ stream }));
    if (state.link.status === 'live') return state;
    return { ...state, link: { status: 'live', stream } };
  };

  /** The state without the claims `gone` picks, their timers called off: the state itself if it picks none. */
  const drop = (state: CameraState, enq: CameraEnqueue, gone: (claim: CameraClaim) => boolean): CameraState => {
    const dropped = state.claims.filter(gone);
    if (dropped.length === 0) return state;
    for (const claim of dropped) {
      if (claim.phase === 'awaiting') disarm(enq, settlingOf(claim.id));
    }
    return { ...state, claims: state.claims.filter(claim => !gone(claim)) };
  };

  /** The agent said how the camera is: claims it agrees with that were waiting on it are done, and the lock moves. */
  const report = (state: CameraState, enq: CameraEnqueue, said: CameraReport): CameraState => {
    const agreed = drop(state, enq, claim => claim.phase === 'awaiting' && agrees(said, claim.change));
    const lock = lockAfter(state.lock, said.holder?.peer ?? null, state.self);
    return { ...agreed, reported: said, lock };
  };

  /**
   * Claim what a command changes and send it, unless the session has stopped (a stopped one keeps no timers, so it
   * only sends): a later claim to the same thing replaces an earlier one.
   */
  const claimAndSend = (state: CameraState, enq: CameraEnqueue, event: CommandedEvent): CameraState => {
    const change = changeOf(event.command);
    const session = state.session;
    if (change === undefined || state.link.status === 'idle') {
      enq.effect(() => void deliver(agent, session, event.command, event.reply, undefined));
      return state;
    }
    const id = state.commands + 1;
    const replaced = drop(state, enq, claim => subjectOf(claim.change) === subjectOf(change));
    enq.effect(({ trigger }) => {
      const told = { taken: () => trigger.taken({ id }), refused: () => trigger.refused({ id }) };
      void deliver(agent, session, event.command, event.reply, told);
    });
    return { ...replaced, commands: id, claims: [...replaced.claims, { id, change, phase: 'sending' }] };
  };

  return createStore<CameraState, CameraEvents>({
    context: {
      self: options.session.peer,
      session: options.session,
      link: IDLE,
      reported: undefined,
      lock: FREE,
      claims: [],
      streams: 0,
      commands: 0
    },
    on: {
      /** The session starts following the camera: the first stream is asked for. */
      started: (state, _event, enq) => {
        if (state.link.status !== 'idle') return state;
        return ask(state, enq, stream => ({ status: 'connecting', stream }));
      },
      /**
       * The session stops: the stream is let go, every timer called off, and every claim given up. What was last
       * reported stays, for a session started again.
       */
      stopped: (state, _event, enq) => {
        if (state.link.status === 'idle') return state;
        enq.effect(() => tasks.stopAll());
        return { ...state, link: IDLE, claims: [] };
      },
      /**
       * The grant was renewed: what is sent from now on goes through it. Through another agent, an open stream is let
       * go and the new agent asked for one.
       */
      renewed: (state, event, enq) => {
        if (event.session === state.session) return state;
        const renewed = { ...state, session: event.session };
        const moved = event.session.agent.publicId !== state.session.agent.publicId;
        if (!moved || openStreamOf(state.link) === undefined) return renewed;
        return ask(renewed, enq, stream => ({ status: 'connecting', stream }));
      },
      /** The open stream carried the camera's state: it is live, and the claims and the lock follow what it says. */
      reported: (state, event, enq) => {
        if (openStreamOf(state.link) !== event.stream) return state;
        return report(hear(state, enq, event.stream), enq, event.report);
      },
      /** The open stream carried something else, a ping most often: it is live. */
      pinged: (state, event, enq) => {
        if (openStreamOf(state.link) !== event.stream) return state;
        return hear(state, enq, event.stream);
      },
      /** The open stream ended as it should, as the agent ends each after ten minutes: the next is asked for soon. */
      ended: (state, event, enq) => {
        if (openStreamOf(state.link) !== event.stream) return state;
        return pause(state, enq, { status: 'reconnecting', retry: WAITING }, RECONNECT_MS);
      },
      /** The open stream failed, or couldn't be opened: it is tried again a little later. */
      failed: (state, event, enq) => {
        if (openStreamOf(state.link) !== event.stream) return state;
        return pause(state, enq, { status: 'lost', failure: event.failure, retry: WAITING }, RETRY_MS);
      },
      /** The open stream has said nothing for `SILENCE_MS`: it is let go, and another asked for at once. */
      silent: (state, event, enq) => {
        if (openStreamOf(state.link) !== event.stream) return state;
        return ask(state, enq, stream => ({ status: 'stale', stream }));
      },
      /** The wait after a stream ended or failed is over: the next is asked for. */
      waited: (state, _event, enq) => {
        const link = state.link;
        if (link.status === 'reconnecting' && link.retry.phase === 'waiting') {
          return ask(state, enq, stream => ({ status: 'reconnecting', retry: { phase: 'asking', stream } }));
        }
        if (link.status === 'lost' && link.retry.phase === 'waiting') {
          const failure = link.failure;
          return ask(state, enq, stream => ({ status: 'lost', failure, retry: { phase: 'asking', stream } }));
        }
        return state;
      },
      /** Whoever is at the controls here takes the camera over from the device locking it. */
      tookOver: (state, event) => {
        if (state.lock.status !== 'locked' || state.lock.peer !== event.peer) return state;
        return { ...state, lock: { status: 'overridden', peer: event.peer } };
      },
      /**
       * Someone at the controls here told the camera to do something. Refused at once while another device locks it;
       * otherwise a drive or stop gives up wherever the zoom was last sent, what it changes is claimed, and it is
       * sent. The reply hears how it went.
       */
      commanded: (state, event, enq) => {
        if (state.lock.status === 'locked') {
          enq.effect(() => event.reply.reject(new CameraLocked()));
          return state;
        }
        // The camera moves each axis on its own: a drive that leaves the zoom be leaves its move going.
        const command = event.command;
        const zoomEnds = command.kind === 'stop' || (command.kind === 'drive' && (command.zoom ?? 0) !== 0);
        const driven = zoomEnds ? drop(state, enq, claim => claim.change.kind === 'zoom') : state;
        return claimAndSend(driven, enq, event);
      },
      /** The camera took a claimed command: its claim waits `SETTLE_MS` for the agent to say so, unless it has. */
      taken: (state, event, enq) => {
        const id = event.id;
        const claim = state.claims.find(candidate => candidate.id === id);
        if (claim === undefined || claim.phase !== 'sending') return state;
        if (agrees(state.reported, claim.change)) return drop(state, enq, candidate => candidate.id === id);
        arm(enq, settlingOf(id), SETTLE_MS, trigger => trigger.settled({ id }));
        const awaiting: CameraClaim = { ...claim, phase: 'awaiting' };
        return { ...state, claims: state.claims.map(candidate => (candidate.id === id ? awaiting : candidate)) };
      },
      /** The camera didn't take a claimed command: what the agent says stands. */
      refused: (state, event, enq) => drop(state, enq, claim => claim.id === event.id),
      /** The agent has had `SETTLE_MS` to agree with a claim and hasn't: what it says stands. */
      settled: (state, event, enq) => drop(state, enq, claim => claim.id === event.id)
    }
  });
}

export type CameraStore = ReturnType<typeof createCameraStore>;

/**
 * Tell the camera to do something, as `commanded`: the promise settles as the command does, rejecting with
 * `CameraLocked` while another device holds the camera, or with the send's own failure.
 */
export function runCommand(store: CameraStore, command: CameraCommand): Promise<void> {
  return new Promise((resolve, reject) => store.trigger.commanded({ command, reply: { resolve, reject } }));
}

/** What an option is set to: what this browser last asked for, until the agent agrees, and the agent's word otherwise. */
export function optionOf(state: CameraState, key: string): string | undefined {
  for (const { change } of state.claims) {
    if (change.kind === 'option' && change.key === key) return change.value;
  }
  return state.reported?.options[key];
}

/**
 * The camera's zoom, 0 to 1: where this browser last sent it, until the agent says it is there, and the agent's word
 * otherwise. Undefined until the agent has said, or for a camera that doesn't report one.
 */
export function zoomOf(state: CameraState): number | undefined {
  for (const { change } of state.claims) {
    if (change.kind === 'zoom') return change.zoom;
  }
  return state.reported?.position.zoom;
}

/** Where the camera points, as the agent last said. */
export function positionOf(state: CameraState): CameraPosition | undefined {
  return state.reported?.position;
}

/** Whether the camera is focusing itself, as far as is known. */
export function autofocusing(state: CameraState): boolean {
  return optionOf(state, 'autofocus') === 'on';
}

/** Whether the agent's stream is being followed, and how that is going. */
export function linkOf(state: CameraState): CameraLink {
  return state.link;
}

/** This browser's device, as the agent names it. */
export function selfOf(state: CameraState): string {
  return state.self;
}

interface HeldByUnknown {
  by: 'unknown';
}

interface HeldByNobody {
  by: 'nobody';
}

interface HeldBySelf {
  by: 'self';
}

interface HeldByOther {
  by: 'other';
  /** The public ID of the device that holds it. */
  peer: string;
}

/**
 * Who is at the camera's controls: not yet known, nobody, this browser, or another device. A camera is held by
 * whoever last moved it, for a little while after.
 */
export type CameraHold = HeldByUnknown | HeldByNobody | HeldBySelf | HeldByOther;

/** The device the agent says holds the camera: null for nobody, undefined until the agent has said. */
export function holderOf(state: CameraState): string | null | undefined {
  if (state.reported === undefined) return undefined;
  return state.reported.holder?.peer ?? null;
}

/** Who holds the camera, seen from the device this browser is. */
export function holdOf(holder: string | null | undefined, self: string): CameraHold {
  if (holder === undefined) return { by: 'unknown' };
  if (holder === null) return { by: 'nobody' };
  return holder === self ? { by: 'self' } : { by: 'other', peer: holder };
}

/**
 * The device the camera is locked by: another device that holds it, and that hasn't been taken over from. Null while
 * the camera is free to move from here.
 */
export function lockedBy(state: CameraState): string | null {
  return state.lock.status === 'locked' ? state.lock.peer : null;
}

/** A command not sent because the camera is locked by another device. */
export class CameraLocked extends Error {
  constructor() {
    super('Someone else is controlling this camera. Take control to move it.');
    this.name = 'CameraLocked';
  }
}

/** One store per control session, made by `CameraControl`. */
export const CameraStoreContext = createContext<CameraStore | null>(null);

function outsideControl(): never {
  throw new Error('This is only for components under a camera’s control session (<CameraControl>).');
}

/** The store of the camera being controlled, for parts under its control session. */
export function useCameraStore(): CameraStore {
  return use(CameraStoreContext) ?? outsideControl();
}

/**
 * Something of the camera being controlled, read with one of the selectors above: the part renders again only when
 * what it reads changes. A selector gives a value the state holds, or a plain one worked out from it, never a new
 * object made on each call: that would read as a change every time.
 */
export function useCamera<Selected>(select: (state: CameraState) => Selected): Selected {
  const store = useCameraStore();
  return useSelector(store, snapshot => select(snapshot.context));
}

/**
 * Where the camera points, as a preset keeps it: without its focus while it focuses itself, since going to a preset
 * that names a focus would switch autofocus off. Undefined until the agent has said where it points.
 */
export function usePresetPosition(): CameraPosition | undefined {
  const position = useCamera(positionOf);
  const focusesItself = useCamera(autofocusing);
  if (position === undefined || !focusesItself) return position;
  const { focus: _focus, ...unfocused } = position;
  return unfocused;
}
