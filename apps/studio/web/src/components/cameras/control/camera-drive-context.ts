import { createContext, use, useEffect, useSyncExternalStore } from 'react';
import type { CameraCapabilities, CameraCommand } from '@conservationtv/cameras';
import { createStore, type EnqueueObject, type TriggerObject } from '@xstate/store';
import { useSelector } from '@xstate/store-react';

import {
  driveOf,
  driveStep,
  gamepadConnected,
  gamepadSteering,
  RESTING,
  sameSteering,
  slowdownAt,
  steeringOf,
  STILL,
  stillInputs,
  TICK_MS,
  type DriveLoop,
  type DriveStep,
  type Steering,
  type SteeringInputs,
  type SteeringSource
} from '@/components/cameras/control/camera-steering';
import type { CameraClock } from '@/components/cameras/control/camera-store';
import { namedTasks, realClock } from '@/components/cameras/control/camera-tasks';

// Driving a camera by hand is a layer of its own within its control session, and this is its store: one per session,
// made and started by camera-drive.tsx, and all that the inputs that steer the camera and the parts that show the
// steering share. Every input (the drag on the picture, the joystick, the zoom lever, a held button, the arrow keys,
// a gamepad) says what it asks for whenever that changes (`steered`), and nothing else: which of them is listened to,
// and what the camera is sent, is decided here. Two machines share the store, and each moves only by the events below:
//
//   run     the loop that drives the camera, turning every TICK_MS between `started` and `stopped`, and only for a
//           camera that can be driven. Each turn is `ticked`, carrying what the loop looked at as it turned: whether
//           another device holds the camera, where its zoom is, what the gamepad's sticks say, and whether this
//           document has the focus. A camera another device holds is left alone, without so much as a stop: that
//           would take it from them. Otherwise the steering listened to, as a drive at the speed the camera's zoom
//           allows, goes to `driveStep` (camera-steering.ts), which sends a changed velocity at once, an unchanged one
//           again every REPEAT_MS (an agent stops a camera not driven again within a second and a half), and `stop`
//           once nothing steers.
//   zoom    the zoom slider, dragged to a place in the camera's range: the camera's zoom is sent there as the slider
//           goes, no more often than ZOOM_SEND_MS, and once more where it is let go.
//
// The gamepad is an input like the rest, but nothing tells the store what it asks for: its sticks are read as the
// loop turns, and count only while it is switched on and this document has the focus. The window losing the focus
// lets every input go at once (`rested`): a hand lifted while another window has the focus is never heard here.
//
// Every command goes out as an effect, through the session, and is numbered as it goes. How the camera took it comes
// back as `took` or `missed`, and only the answer for the latest send is heard: an older one, arriving late, says
// nothing of how things are now.
//
// The turning and the window's blur listener are effects, each kept under a name so that a later event can call it
// off: `stopped` calls both off. Time is the clock and the `now` the store is made with, the gamepad and the focus are
// read through what it is given, and the commands go through its `send`: the real ones, or fakes to drive the store
// by hand.
//
//   run      off ── started, by a camera that can be driven ──▶ on·resting ◀───────────────────────────┐
//                                                                 │   ▲                                 │
//                                          ticked: a drive        │   │ ticked: no drive (sends `stop`) │
//                                          (sends it)             ▼   │                                 │
//                                                               on·driving ── ticked: another device ───┘
//                                                                 │  ▲        holds the camera (sends nothing)
//                                                                 └──┘ ticked: a changed drive, or the same
//                                                                      one once REPEAT_MS has passed (sends it)
//
//            From on: stopped ─▶ off, sending `stop` first if driving (unless another device has taken the camera
//            since the last turn); `started` again by a camera that can't be driven, the same. `started` again by one
//            that can keeps the loop where it is, with what the camera can do now. Any turn while another device holds
//            the camera ─▶ on·resting, sending nothing.
//
//   zoom     idle ── zoomDragged ──▶ dragging ── zoomReleased, or rested (sends where it is) ──▶ idle
//                    (sends unless     │  ▲
//                    one went within   └──┘ zoomDragged (the same)
//                    ZOOM_SEND_MS)
//
//            From dragging: zoomDropped (the slider taken away mid-drag) ─▶ idle, sending nothing. Both states keep
//            when the zoom was last sent, so the throttle holds from one drag to the next.

/** The most often the camera is sent a new zoom while the slider is dragged. */
export const ZOOM_SEND_MS = 150;

/** Not driving: before the loop starts, after it stops, and for a camera that can't be driven. */
interface RunOff {
  status: 'off';
}

/** Turning every TICK_MS, for a camera with these capabilities: resting or driving, as `loop` says. */
interface RunOn {
  status: 'on';
  capabilities: CameraCapabilities;
  loop: DriveLoop;
}

/** Whether the loop that drives the camera is turning, and where it is. */
export type DriveRun = RunOff | RunOn;

const OFF: DriveRun = { status: 'off' };

/** The zoom slider not dragged. */
interface ZoomIdle {
  status: 'idle';
  /** When the zoom was last sent from the slider, in epoch milliseconds; undefined if it never has been. */
  sentAt: number | undefined;
}

/** The zoom slider dragged to `to`, 0 to 1, where its knob is drawn until it is let go. */
interface ZoomDragging {
  status: 'dragging';
  to: number;
  sentAt: number | undefined;
}

/** Whether the zoom slider is dragged, and where to. */
export type ZoomDrag = ZoomIdle | ZoomDragging;

export interface DriveState {
  /** What each input is asking for now. A gamepad's is what its sticks said at the loop's last turn. */
  inputs: SteeringInputs;
  /** Whether a gamepad is listened to. Off, it does nothing, however it is held. */
  gamepadEnabled: boolean;
  run: DriveRun;
  zoom: ZoomDrag;
  /** The last command sent, by number: only its answer is heard. */
  sends: number;
  /** Why the camera didn't take the last thing sent it; undefined once it takes one. */
  failure: string | undefined;
}

/** What the loop looks at of the camera as it turns, from the session's store. */
export interface DriveCamera {
  /** Whether another device holds the camera: nothing is sent it while one does. */
  locked: boolean;
  /** Where its zoom is, 0 to 1, as its agent last said: the further in, the slower it is steered. */
  zoom: number | undefined;
}

/** Everything the loop looks at as it turns. */
export interface DriveSight extends DriveCamera {
  /** What the gamepad's sticks ask for, whether or not it is listened to. */
  gamepad: Steering;
  /** Whether this document has the focus: without it, a gamepad steers nothing here. */
  focused: boolean;
}

export interface DriveStoreOptions {
  /** Send the camera a command through the session as it is when sent. Rejects, in words, if it isn't taken. */
  send: (command: CameraCommand) => Promise<void>;
  /** What the loop looks at of the camera as it turns. */
  camera: () => DriveCamera;
  /** The real clock unless another is given. */
  clock?: CameraClock;
  /** Epoch milliseconds now: the real time unless another is given. */
  now?: () => number;
  /** What the gamepad's sticks ask for: the first connected gamepad's, unless another reader is given. */
  gamepad?: () => Steering;
  /** Whether this document has the focus. */
  focused?: () => boolean;
  /** Listen for the window losing the focus, until what it returns is called. */
  blurs?: (blurred: () => void) => () => void;
}

interface StartedEvent {
  /** What the camera can do, as its agent says; null for a camera it can't say of. */
  capabilities: CameraCapabilities | null;
}

interface TickedEvent {
  sight: DriveSight;
}

interface SteeredEvent {
  source: SteeringSource;
  steering: Steering;
}

interface GamepadSwitchedEvent {
  enabled: boolean;
}

interface ZoomDraggedEvent {
  /** Where the slider is dragged to, 0 to 1. */
  zoom: number;
}

interface TookEvent {
  send: number;
}

interface MissedEvent extends TookEvent {
  failure: string;
}

type NoPayload = Record<never, never>;

/** Every event the store takes, by name. Each is described where it is handled, in `createDriveStore`. */
type DriveEvents = {
  started: StartedEvent;
  stopped: NoPayload;
  ticked: TickedEvent;
  steered: SteeredEvent;
  rested: NoPayload;
  gamepadSwitched: GamepadSwitchedEvent;
  zoomDragged: ZoomDraggedEvent;
  zoomReleased: NoPayload;
  zoomDropped: NoPayload;
  took: TookEvent;
  missed: MissedEvent;
};

type DriveEnqueue = EnqueueObject<DriveState, never, DriveEvents>;
type DriveTrigger = TriggerObject<DriveEvents>;

/** The loop's turning and the window's blur listener, by the names they are kept under. */
const TICK = 'tick';
const BLUR = 'blur';

/** Whether a camera can be driven: only one whose agent says it moves continuously. */
const drivable = (capabilities: CameraCapabilities | null): capabilities is CameraCapabilities =>
  capabilities !== null && capabilities.moves.includes('continuous');

/** Whether any input is asking for anything: `steeringOf` comes to `STILL` itself when none is. */
const anySteering = (inputs: SteeringInputs) => steeringOf(inputs) !== STILL;

/** The inputs with the gamepad's sticks taken in, as the loop read them: the same inputs if that changes nothing. */
function withGamepad(state: DriveState, sight: DriveSight): SteeringInputs {
  // Switched off, or with another window in front, the gamepad steers nothing here.
  const listening = state.gamepadEnabled && sight.focused;
  const pad = listening ? sight.gamepad : STILL;
  if (sameSteering(pad, state.inputs.gamepad)) return state.inputs;
  return { ...state.inputs, gamepad: pad };
}

/**
 * Where one turn takes the loop, and what it sends on the way: the steering listened to, as a drive at the speed the
 * camera's zoom allows, through `driveStep`. A camera another device holds is left alone, without so much as a stop:
 * that would take it from whoever holds it.
 */
function stepAt(run: RunOn, inputs: SteeringInputs, sight: DriveSight, at: number): DriveStep {
  if (sight.locked) return { loop: RESTING, command: undefined };
  const listened = steeringOf(inputs);
  const slowdown = slowdownAt(sight.zoom);
  const drive = driveOf(listened, run.capabilities, slowdown);
  return driveStep(run.loop, drive, at);
}

function realBlurs(blurred: () => void): () => void {
  window.addEventListener('blur', blurred);
  return () => window.removeEventListener('blur', blurred);
}

/** The store of driving one control session's camera by hand. */
export function createDriveStore(options: DriveStoreOptions) {
  const clock = options.clock ?? realClock;
  const now = options.now ?? Date.now;
  const readGamepad = options.gamepad ?? gamepadSteering;
  const focused = options.focused ?? (() => document.hasFocus());
  const blurs = options.blurs ?? realBlurs;
  const tasks = namedTasks();

  /** Everything the loop looks at, read as it turns. */
  const look = (): DriveSight => ({ ...options.camera(), gamepad: readGamepad(), focused: focused() });

  /** Turn the loop again in TICK_MS, in place of any turn already due. */
  const armTick = (enq: DriveEnqueue) => {
    enq.effect(({ trigger }) => {
      tasks.start(TICK, () =>
        clock(TICK_MS, () => {
          tasks.stop(TICK);
          trigger.ticked({ sight: look() });
        })
      );
    });
  };

  /** Send a command, numbered as the latest: its answer comes back as `took` or `missed`. */
  const dispatch = (state: DriveState, enq: DriveEnqueue, command: CameraCommand): DriveState => {
    const send = state.sends + 1;
    enq.effect(({ trigger }) => void deliver(options.send, command, send, trigger));
    return { ...state, sends: send };
  };

  /**
   * The loop stops turning: the tick and the blur listener are let go, and a camera being driven is stopped, unless
   * another device has taken it since the last turn, which is looked at here as a turn would.
   */
  const halt = (state: DriveState, enq: DriveEnqueue): DriveState => {
    if (state.run.status === 'off') return state;
    enq.effect(() => tasks.stopAll());
    if (state.run.loop.status !== 'driving') return { ...state, run: OFF };
    const camera = options.camera();
    const stopped = camera.locked ? state : dispatch(state, enq, { kind: 'stop' });
    return { ...stopped, run: OFF };
  };

  /** The slider let go where it was dragged: the zoom is sent there, whatever the throttle says. */
  const release = (state: DriveState, enq: DriveEnqueue): DriveState => {
    if (state.zoom.status !== 'dragging') return state;
    const sent = dispatch(state, enq, { kind: 'moveTo', zoom: state.zoom.to });
    return { ...sent, zoom: { status: 'idle', sentAt: now() } };
  };

  return createStore<DriveState, DriveEvents>({
    context: {
      inputs: stillInputs(),
      gamepadEnabled: true,
      run: OFF,
      zoom: { status: 'idle', sentAt: undefined },
      sends: 0,
      failure: undefined
    },
    on: {
      /**
       * The camera's agent said what the camera can do: the loop starts turning, and the window's blur is listened
       * for, for a camera that can be driven. Said again, the loop keeps going with what it can do now, or stops if
       * it can no longer be driven.
       */
      started: (state, event, enq) => {
        const capabilities = event.capabilities;
        if (!drivable(capabilities)) return halt(state, enq);
        if (state.run.status === 'on') return { ...state, run: { ...state.run, capabilities } };
        armTick(enq);
        enq.effect(({ trigger }) => tasks.start(BLUR, () => blurs(() => trigger.rested())));
        return { ...state, run: { status: 'on', capabilities, loop: RESTING } };
      },
      /** The loop stops, as the session or its camera's capabilities go: a camera mid-move is sent `stop`. */
      stopped: (state, _event, enq) => halt(state, enq),
      /**
       * The loop turns, with what it looked at: the gamepad's steering is taken in, and what the steering listened to
       * comes to (`driveStep`) is sent, unless another device holds the camera. The next turn is due in TICK_MS.
       */
      ticked: (state, event, enq) => {
        const run = state.run;
        if (run.status !== 'on') return state;
        armTick(enq);
        const sight = event.sight;
        const inputs = withGamepad(state, sight);
        const at = now();
        const step = stepAt(run, inputs, sight, at);
        if (step.command === undefined && step.loop === run.loop && inputs === state.inputs) return state;
        const sent = step.command === undefined ? state : dispatch(state, enq, step.command);
        return { ...sent, inputs, run: { ...run, loop: step.loop } };
      },
      /** An input says what it is asking for now: `STILL` once it lets go. */
      steered: (state, event) => {
        if (sameSteering(state.inputs[event.source], event.steering)) return state;
        return { ...state, inputs: { ...state.inputs, [event.source]: event.steering } };
      },
      /**
       * Every input lets go at once, the zoom slider among them: the window lost the focus mid-hold, and will never
       * hear the release. The loop stops the camera at its next turn.
       */
      rested: (state, _event, enq) => {
        const released = release(state, enq);
        if (!anySteering(released.inputs)) return released;
        return { ...released, inputs: stillInputs() };
      },
      /** The gamepad is switched on or off. Off, what it was asking for is let go at once. */
      gamepadSwitched: (state, event) => {
        if (state.gamepadEnabled === event.enabled) return state;
        const inputs = event.enabled ? state.inputs : { ...state.inputs, gamepad: STILL };
        return { ...state, gamepadEnabled: event.enabled, inputs };
      },
      /**
       * The zoom slider is pressed or dragged to a place: its knob is drawn there, and the camera's zoom is sent there
       * unless it was sent within ZOOM_SEND_MS.
       */
      zoomDragged: (state, event, enq) => {
        const sentAt = state.zoom.sentAt;
        const at = now();
        if (sentAt !== undefined && at - sentAt < ZOOM_SEND_MS) {
          return { ...state, zoom: { status: 'dragging', to: event.zoom, sentAt } };
        }
        const sent = dispatch(state, enq, { kind: 'moveTo', zoom: event.zoom });
        return { ...sent, zoom: { status: 'dragging', to: event.zoom, sentAt: at } };
      },
      /** The zoom slider is let go: the camera's zoom is sent where it was, once more. */
      zoomReleased: (state, _event, enq) => release(state, enq),
      /** The zoom slider is taken away mid-drag: it is let go, and nothing more is sent. */
      zoomDropped: state => {
        if (state.zoom.status !== 'dragging') return state;
        return { ...state, zoom: { status: 'idle', sentAt: state.zoom.sentAt } };
      },
      /** The camera took the latest thing sent it. */
      took: (state, event) => {
        if (event.send !== state.sends || state.failure === undefined) return state;
        return { ...state, failure: undefined };
      },
      /** The camera didn't take the latest thing sent it. */
      missed: (state, event) => {
        if (event.send !== state.sends) return state;
        return { ...state, failure: event.failure };
      }
    }
  });
}

/** Send one command, telling the store how it went, as send number `send`. */
async function deliver(
  send: DriveStoreOptions['send'],
  command: CameraCommand,
  number: number,
  trigger: DriveTrigger
): Promise<void> {
  try {
    await send(command);
  } catch (error) {
    trigger.missed({ send: number, failure: error instanceof Error ? error.message : String(error) });
    return;
  }
  trigger.took({ send: number });
}

export type DriveStore = ReturnType<typeof createDriveStore>;

/** Whether the loop is turning and has a velocity out that the camera's agent keeps only while it is repeated. */
export function drivingOf(state: DriveState): boolean {
  return state.run.status === 'on' && state.run.loop.status === 'driving';
}

/** Where the zoom slider is dragged to, 0 to 1, or null while it isn't. */
export function draggedZoomOf(state: DriveState): number | null {
  return state.zoom.status === 'dragging' ? state.zoom.to : null;
}

/** One store per control session, made by `CameraDriving`. */
export const DriveStoreContext = createContext<DriveStore | null>(null);

function outsideDrive(): never {
  throw new Error('This is only for components under a camera’s control session (<CameraControl>).');
}

/** The store of driving the camera by hand, for parts under a control session. */
export function useDriveStore(): DriveStore {
  return use(DriveStoreContext) ?? outsideDrive();
}

/**
 * Steering as one of the loop's inputs: what it returns says what the input asks for now. The input lets go by
 * itself when the part that holds it is taken away, so a control removed mid-hold never leaves the camera turning.
 */
export function useSteer(source: SteeringSource): (steering: Steering) => void {
  const store = useDriveStore();
  useEffect(() => () => store.trigger.steered({ source, steering: STILL }), [store, source]);
  return steering => store.trigger.steered({ source, steering });
}

/**
 * The steering being listened to now, whichever input it comes from: what a control that shows the steering, as the
 * joystick does, draws.
 */
export function useSteering(): Steering {
  const store = useDriveStore();
  return useSelector(store, snapshot => steeringOf(snapshot.context.inputs));
}

/** Why the camera didn't take the last thing driving it by hand sent it, if it didn't. */
export function useDriveFailure(): string | undefined {
  const store = useDriveStore();
  return useSelector(store, snapshot => snapshot.context.failure);
}

/** The zoom slider as an input: where it is dragged to, if it is, and how to say it is dragged and let go. */
export interface CameraZoomDrag {
  /** Where the slider is dragged to, 0 to 1, or null while it isn't. */
  dragged: number | null;
  /** Say the slider is pressed or dragged to a place, 0 to 1. */
  drag: (zoom: number) => void;
  /** Say the slider is let go. */
  release: () => void;
}

/**
 * The zoom slider, as the store has it. A slider taken away mid-drag is let go without sending anything more, so one
 * put back starts afresh.
 */
export function useZoomDrag(): CameraZoomDrag {
  const store = useDriveStore();
  const dragged = useSelector(store, snapshot => draggedZoomOf(snapshot.context));
  useEffect(() => () => store.trigger.zoomDropped(), [store]);
  return {
    dragged,
    drag: zoom => store.trigger.zoomDragged({ zoom }),
    release: () => store.trigger.zoomReleased()
  };
}

function subscribeToGamepads(changed: () => void): () => void {
  window.addEventListener('gamepadconnected', changed);
  window.addEventListener('gamepaddisconnected', changed);
  return () => {
    window.removeEventListener('gamepadconnected', changed);
    window.removeEventListener('gamepaddisconnected', changed);
  };
}

/** A gamepad, as the loop sees it, and its switch. It steers only while it is both connected and switched on. */
export interface CameraGamepad {
  connected: boolean;
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
}

export function useGamepad(): CameraGamepad {
  const store = useDriveStore();
  const enabled = useSelector(store, snapshot => snapshot.context.gamepadEnabled);
  const connected = useSyncExternalStore(subscribeToGamepads, gamepadConnected, () => false);
  return { connected, enabled, setEnabled: next => store.trigger.gamepadSwitched({ enabled: next }) };
}
