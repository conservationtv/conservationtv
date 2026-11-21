import {
  admits,
  CameraCredentialsSchema,
  CameraSettingsSchema,
  moveOf,
  type CameraCapabilities,
  type CameraCommand,
  type CameraOptionValues,
  type CameraPosition
} from '@conservationtv/cameras';
import { cameraDriver, type CameraDriver, UnsupportedCommand } from '@conservationtv/cameras/control';
import { createStore } from '@conservationtv/store';
import { BehaviorSubject, Observable } from 'rxjs';
import { z } from 'zod';
import {
  Alarms,
  CAMERA_TIMEOUT_MS,
  cameraStore,
  type CameraStore,
  heldAgainst,
  ledgerStore,
  realTime,
  settlement,
  spentAlready,
  stateOf,
  type Time,
  toldOf,
  until
} from './camera-machine.ts';
import { type Admitted, GrantRefused } from './grants.ts';

// The `cameras` key: the cameras the agent reaches, controlled through their drivers (`@conservationtv/cameras`) for
// whoever presents a grant the studio API signed (grants.ts). The drivers only translate; everything about who may
// move a camera, and what happens when they stop, is here:
//
//   grants       a command must be one its grant admits, for this camera; a grant for one command admits it once;
//   holding      a person at the controls holds the camera while their commands keep coming, and for a little after.
//                While they do, automation (a chat command, say) is turned away; another person takes it over;
//   driving      a `drive` keeps the camera moving only while it is repeated. One that goes quiet is stopped, so a
//                lost connection never leaves a camera turning, and neither does a command that fails meanwhile.
//
// Only an `enabled` camera is controlled. What a camera can do is asked of it once, and again after it didn't answer.
//
// What is known of each camera, and every change to it, is its store (camera-machine.ts, where its machines are
// drawn); the grants already used are another. This class is the shell around them: it checks what a caller hands it,
// turns each call into the store's events, and waits for the store to say how it came out. It keeps no state of its
// own beyond which cameras it controls: the status, the watch's pace and the timers are all read off the stores.

const CameraSpecSchema = z.object({
  id: z.string(),
  settings: CameraSettingsSchema,
  credentials: CameraCredentialsSchema.optional(),
  state: z.enum(['enabled', 'locked', 'disabled'])
});
type CameraSpec = z.output<typeof CameraSpecSchema>;

export const CamerasSpecSchema = z.object({
  /** Who signs the grants that admit commands: the studio API's URL. */
  issuer: z.string(),
  cameras: z.array(CameraSpecSchema)
});
export type CamerasSpec = z.output<typeof CamerasSpecSchema>;

/** A camera the agent doesn't control: not one of its cameras, or not `enabled`. */
export class UnknownCamera extends Error {
  constructor(cameraId: string) {
    super(`No camera ${cameraId} is controlled here`);
    this.name = 'UnknownCamera';
  }
}

/** A command turned away because someone is at the camera's controls. */
export class CameraHeld extends Error {
  constructor() {
    super('Someone is at the camera’s controls');
    this.name = 'CameraHeld';
  }
}

/** Who is at a camera's controls, and until when unless they go on. */
export interface CameraHolder {
  /** The endpoint ID of their device. */
  peer: string;
  /** ISO 8601. */
  expiresAt: string;
}

/** A camera as it is now: where it points, what its options are set to, and who holds it. */
export interface CameraControlState {
  position: CameraPosition;
  options: CameraOptionValues;
  holder: CameraHolder | null;
  /** ISO 8601. */
  observedAt: string;
}

/** A camera the agent controls, and what it can do: null while it hasn't answered. */
export interface ControlledCamera {
  id: string;
  capabilities: CameraCapabilities | null;
}

/** The runtime's status: how many cameras it controls, and who holds each that is held. */
export interface CamerasStatus {
  cameras: number;
  held: Record<string, string>;
}

/** What a camera control is built with: the real clock, timers and drivers unless told otherwise. */
export interface CameraControlOptions {
  time?: Time;
  driverOf?: (camera: CamerasSpec['cameras'][number]) => CameraDriver;
}

/** One camera the agent controls. */
interface Controlled {
  id: string;
  /** What it was built from, to tell a changed registration from the same one. */
  registration: string;
  driver: CameraDriver;
  /** Everything known of it, and every change to it. */
  store: CameraStore;
  /** Its store's timers. */
  alarms: Alarms;
  /** Calls off what is being asked of the camera, when it is let go of. */
  reads: AbortController;
  /** Calls off everything it has in hand, when the control is disposed of. */
  ends: AbortController;
  /** Its state while anyone watches, asked of the camera once for all of them. */
  watched: Observable<CameraControlState>;
  /** Stops the status following its store, once it is let go of. */
  unfollow: () => void;
}

/** Controls the agent's cameras: the `cameras` key's runtime, and what the agent API's camera routes call. */
export class CameraControl {
  readonly status$ = new BehaviorSubject<CamerasStatus>({ cameras: 0, held: {} });
  private issuer = '';
  private readonly cameras = new Map<string, Controlled>();
  /** The single-command grants already used. */
  private readonly ledger = ledgerStore();
  private readonly time: Time;
  private readonly driverOf: (camera: CameraSpec) => CameraDriver;

  constructor(options: CameraControlOptions = {}) {
    this.time = options.time ?? realTime;
    this.driverOf = options.driverOf ?? (camera => cameraDriver(camera.settings, camera.credentials));
  }

  /** Who signs the grants that admit commands here. */
  get grantIssuer(): string {
    return this.issuer;
  }

  /** Control the spec's enabled cameras from now on: one whose registration changed gets a new driver. */
  async apply(spec: CamerasSpec): Promise<void> {
    this.issuer = spec.issuer;
    const enabled = new Map(
      spec.cameras.filter(camera => camera.state === 'enabled').map(camera => [camera.id, camera])
    );
    // The cameras let go of with a stop they didn't take: one that comes back under a new registration is stopped
    // at once by its new driver.
    const moving = new Set<string>();
    for (const [id, camera] of this.cameras) {
      const next = enabled.get(id);
      if (next !== undefined && registrationOf(next) === camera.registration) continue;
      const left = await this.release(camera);
      if (left) moving.add(id);
    }
    const at = this.time.now();
    for (const [id, camera] of enabled) {
      if (this.cameras.has(id)) continue;
      const controlled = this.controlled(id, camera);
      this.cameras.set(id, controlled);
      if (moving.has(id)) controlled.store.trigger.adopted({ at });
    }
    this.derive();
  }

  /** Stop controlling every camera, stopping any that is being driven. */
  async teardown(): Promise<void> {
    for (const camera of this.cameras.values()) await this.release(camera);
    const at = this.time.now();
    this.ledger.trigger.cleared({ at });
    this.derive();
  }

  /** Stop everything at once: nothing more is said to any camera, and no timer is left set. */
  dispose(): void {
    const at = this.time.now();
    for (const camera of this.cameras.values()) {
      camera.store.trigger.disposed({ at });
      camera.ends.abort();
      camera.reads.abort();
    }
  }

  /** The cameras controlled here, each with what it can do. */
  async list(): Promise<ControlledCamera[]> {
    const cameras = [...this.cameras.values()];
    return Promise.all(
      cameras.map(async camera => {
        const capabilities = await this.capabilities(camera);
        return { id: camera.id, capabilities: capabilities ?? null };
      })
    );
  }

  /** The camera as it is now, asked of the camera. */
  async state(cameraId: string): Promise<CameraControlState> {
    const camera = this.require(cameraId);
    const { driver } = camera;
    const timeout = new AbortController();
    const cancel = this.time.after(CAMERA_TIMEOUT_MS, () => timeout.abort());
    const signal = AbortSignal.any([timeout.signal, camera.ends.signal]);
    try {
      const position = await driver.position(signal);
      const options = await driver.options(signal);
      const snapshot = camera.store.getSnapshot();
      const at = this.time.now();
      return stateOf(position, options, snapshot.context.hold, at);
    } finally {
      cancel();
    }
  }

  /** The camera's state from now on, each time it changes, starting with what it is: until unsubscribed. */
  watch(cameraId: string): Observable<CameraControlState> {
    const camera = this.require(cameraId);
    return camera.watched;
  }

  /** Carry out a command its grant admits: `GrantRefused`, `CameraHeld` or `UnsupportedCommand` otherwise. */
  async run(cameraId: string, command: CameraCommand, admitted: Admitted): Promise<void> {
    const camera = this.require(cameraId);
    const { grant, holder } = admitted;
    if (grant.cameraId !== cameraId) throw new GrantRefused('it is for another camera');
    if (!admits(grant, command)) throw new GrantRefused('it is for another command');
    await this.requireCapable(camera, command);
    // From here to the command being sent is one step: nothing else happens to the camera, or the grants, between.
    const at = this.time.now();
    const { store } = camera;
    const { context } = store.getSnapshot();
    if (context.life.status !== 'controlled') throw new UnknownCamera(cameraId);
    if (heldAgainst(context.hold, holder, grant.priority, at)) throw new CameraHeld();
    if (grant.scope.kind === 'command') this.spend(admitted, at);
    const id = crypto.randomUUID();
    const settled = settlement(store, id);
    store.trigger.commanded({ id, command, peer: holder, priority: grant.priority, at });
    const outcome = await settled;
    switch (outcome.status) {
      case 'done':
        return;
      case 'held':
        throw new CameraHeld();
      case 'gone':
        throw new UnknownCamera(cameraId);
      case 'failed':
        throw outcome.error;
    }
  }

  private require(cameraId: string): Controlled {
    const camera = this.cameras.get(cameraId);
    if (camera === undefined) throw new UnknownCamera(cameraId);
    return camera;
  }

  private controlled(id: string, spec: CameraSpec): Controlled {
    const driver = this.driverOf(spec);
    const reads = new AbortController();
    const ends = new AbortController();
    const { time } = this;
    const store = cameraStore(id, { driver, time, reads: reads.signal, ends: ends.signal });
    const alarms = new Alarms(store, time);
    // The timers follow the store for good: once it is let go of, its state wants none.
    store.subscribe(() => alarms.sync());
    const following = store.subscribe(() => this.derive());
    const unfollow = () => following.unsubscribe();
    const watched = this.watching(store);
    return { id, registration: registrationOf(spec), driver, store, alarms, reads, ends, watched, unfollow };
  }

  /** Stop the camera if it may be moving, and forget it: whether it may still be moving, its stop not taken. */
  private async release(camera: Controlled): Promise<boolean> {
    this.cameras.delete(camera.id);
    const at = this.time.now();
    camera.store.trigger.released({ at });
    camera.reads.abort();
    const context = await until(camera.store, next => next.life.status === 'released');
    camera.unfollow();
    return context.life.status === 'released' && context.life.moving;
  }

  /** What the camera can do: asked once, and again each time until it answers. */
  private async capabilities(camera: Controlled): Promise<CameraCapabilities | undefined> {
    const at = this.time.now();
    camera.store.trigger.capabilitiesWanted({ at });
    const context = await until(camera.store, next => next.capabilities.status !== 'asking');
    const { capabilities } = context;
    return capabilities.status === 'known' ? capabilities.capabilities : undefined;
  }

  /** Refuses a move the camera never offered, before anything is sent to it. */
  private async requireCapable(camera: Controlled, command: CameraCommand): Promise<void> {
    const move = moveOf(command);
    if (move === undefined) return;
    const capabilities = await this.capabilities(camera);
    if (capabilities !== undefined && !capabilities.moves.includes(move)) throw new UnsupportedCommand(command.kind);
  }

  /** Use up a grant that admits one command: `GrantRefused` if it already was. */
  private spend(admitted: Admitted, at: number): void {
    const { id, expiresAt } = admitted;
    const snapshot = this.ledger.getSnapshot();
    if (spentAlready(snapshot.context, id, at)) throw new GrantRefused('it has been used');
    this.ledger.trigger.spent({ id, expiresAt, at });
  }

  /**
   * The camera's state while anyone watches it, as its store tells it: the latest replayed to whoever starts
   * watching, then each that differs, until they leave or the camera is no longer controlled. The store asks the
   * camera once however many watch, and stops when the last one leaves.
   */
  private watching(store: CameraStore): Observable<CameraControlState> {
    const { time } = this;
    return new Observable<CameraControlState>(subscriber => {
      const { context } = store.getSnapshot();
      if (context.life.status !== 'controlled') {
        subscriber.complete();
        return;
      }
      // What this watcher was last told, so it is told each state once.
      let last: CameraControlState | undefined = undefined;
      const tell = (told: CameraControlState | undefined) => {
        if (told === undefined || told === last) return;
        last = told;
        subscriber.next(told);
      };
      const ended = store.on('ended', () => subscriber.complete());
      store.trigger.watcherJoined({ at: time.now() });
      const current = store.getSnapshot();
      tell(toldOf(current.context));
      const following = store.subscribe(next => tell(toldOf(next.context)));
      return () => {
        following.unsubscribe();
        ended.unsubscribe();
        store.trigger.watcherLeft({ at: time.now() });
      };
    });
  }

  /** The status, as the stores say it: published when it changes. */
  private derive(): void {
    const held: Record<string, string> = {};
    for (const [id, camera] of this.cameras) {
      const { hold } = camera.store.getSnapshot().context;
      if (hold.status === 'held') held[id] = hold.peer;
    }
    const status = { cameras: this.cameras.size, held };
    const current = this.status$.getValue();
    if (JSON.stringify(current) === JSON.stringify(status)) return;
    this.status$.next(status);
  }
}

/** A camera's registration as one string, to compare two of them. */
function registrationOf(spec: CameraSpec): string {
  return JSON.stringify([spec.settings, spec.credentials]);
}

/** The agent's camera control. The agent supplies it on start; the API's camera routes read it with `useCameraControl()`. */
export const [withCameraControl, useCameraControl] = createStore<CameraControl>('cameraControl');
