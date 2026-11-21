import { createStore, type EnqueueObject } from '@xstate/store';

import { gamepadShoulder } from '@/components/cameras/control/drive/camera-steering';
import type { CameraClock } from '@/components/cameras/control/store/camera-store';
import { namedTasks, realClock } from '@/components/cameras/control/store/camera-tasks';

// A gamepad's shoulder buttons, as a page that steps between cameras hears them: L1 for the one before, R1 for the
// one after, once for each press however long it is held. A page has one of these, above any camera's control
// session, so what was held at the last look is kept across the swap the press itself makes: the button still held
// as the next camera comes on screen is not a second press.
//
// The Gamepad API says nothing as buttons change: the buttons are looked at every SHOULDER_POLL_MS, an effect kept
// under a name so that `stopped` can call it off, and each look is `polled`, carrying what was held and whether this
// document had the focus. A step is said as the emitted event `stepped`, for the page to act on. Time is the clock the
// store is made with, and the buttons and the focus are read through what it is given: the real ones, or fakes.
//
//   idle ── started ──▶ polling·held 0 ── polled: L1 or R1 held (emits `stepped` its way) ──▶ polling·held ±1
//                         ▲                                                                    │  │  ▲
//                         └──── polled: neither held, both, or the document without the focus ─┘  └──┘
//                                                         polled: the other one instead (emits `stepped` its way)
//
//   From polling: stopped ─▶ idle, the poll called off. A look that finds what the last one did changes nothing.

/** How often a gamepad's shoulder buttons are looked at. */
export const SHOULDER_POLL_MS = 50;

/** Not looking at the buttons. */
interface ShouldersIdle {
  status: 'idle';
}

/** Looking at the buttons, with what was held at the last look: -1 for L1, 1 for R1, 0 for neither or both. */
interface ShouldersPolling {
  status: 'polling';
  held: number;
}

export interface ShoulderState {
  shoulders: ShouldersIdle | ShouldersPolling;
}

export interface ShoulderStoreOptions {
  /** The real clock unless another is given. */
  clock?: CameraClock;
  /** Which shoulder button is held: the first connected gamepad's, unless another reader is given. */
  shoulder?: () => number;
  /** Whether this document has the focus: without it, a press steps nothing here. */
  focused?: () => boolean;
}

interface PolledEvent {
  /** Which shoulder button was held: -1, 1, or 0. */
  shoulder: number;
  focused: boolean;
}

interface SteppedEvent {
  /** Which way to step: -1 for the camera before, 1 for the one after. */
  by: number;
}

type NoPayload = Record<never, never>;

/** Every event the store takes, by name. Each is described where it is handled, in `createShoulderStore`. */
type ShoulderEvents = {
  started: NoPayload;
  stopped: NoPayload;
  polled: PolledEvent;
};

/** What the store says, for the page to act on. */
type ShoulderEmitted = {
  stepped: SteppedEvent;
};

/** `stepped`, as it is emitted. */
interface SteppedEmitted extends SteppedEvent {
  type: 'stepped';
}

type ShoulderEnqueue = EnqueueObject<ShoulderState, SteppedEmitted, ShoulderEvents>;

const POLL = 'poll';
const IDLE: ShoulderState = { shoulders: { status: 'idle' } };

/** The store of a gamepad's shoulder buttons, for a page that steps between cameras with them. */
export function createShoulderStore(options: ShoulderStoreOptions = {}) {
  const clock = options.clock ?? realClock;
  const shoulder = options.shoulder ?? gamepadShoulder;
  const focused = options.focused ?? (() => document.hasFocus());
  const tasks = namedTasks();

  /** Look at the buttons again in SHOULDER_POLL_MS. */
  const armPoll = (enq: ShoulderEnqueue) => {
    enq.effect(({ trigger }) => {
      tasks.start(POLL, () =>
        clock(SHOULDER_POLL_MS, () => {
          tasks.stop(POLL);
          trigger.polled({ shoulder: shoulder(), focused: focused() });
        })
      );
    });
  };

  return createStore<ShoulderState, ShoulderEvents, ShoulderEmitted>({
    context: IDLE,
    on: {
      /** The page starts listening to the buttons, with nothing taken for held. */
      started: (state, _event, enq) => {
        if (state.shoulders.status !== 'idle') return state;
        armPoll(enq);
        return { shoulders: { status: 'polling', held: 0 } };
      },
      /** The page stops listening: the poll is called off. */
      stopped: (state, _event, enq) => {
        if (state.shoulders.status === 'idle') return state;
        enq.effect(() => tasks.stopAll());
        return IDLE;
      },
      /**
       * The buttons were looked at: a button held now that wasn't at the last look is a press, and steps its way.
       * Without the focus, nothing counts as held. The next look is due in SHOULDER_POLL_MS.
       */
      polled: (state, event, enq) => {
        if (state.shoulders.status !== 'polling') return state;
        armPoll(enq);
        const held = event.focused ? event.shoulder : 0;
        if (held === state.shoulders.held) return state;
        if (held !== 0) enq.emit.stepped({ by: held });
        return { shoulders: { status: 'polling', held } };
      }
    }
  });
}

export type ShoulderStore = ReturnType<typeof createShoulderStore>;
