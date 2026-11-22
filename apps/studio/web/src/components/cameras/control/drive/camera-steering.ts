import type { CameraCapabilities, CameraCommand, Drive } from '@conservationtv/cameras';

// Steering a camera by hand, as numbers: what each input asks for, which of them is listened to, and the `drive`
// command that comes to, and when that command is to be sent. The loop that turns these into sends is the drive store
// (camera-drive-context.ts); the inputs are the parts that feed it. Nothing here keeps any state of its own.

/** A velocity on each axis being steered, -1 to 1: pan positive to the right, tilt upwards, zoom inwards, focus further. */
export interface Steering {
  pan: number;
  tilt: number;
  zoom: number;
  focus: number;
}

export const STILL: Steering = { pan: 0, tilt: 0, zoom: 0, focus: 0 };

/**
 * The inputs that steer, most deliberate first. Only one is listened to at a time, the first that is steering: a drag
 * on the picture wins over the joystick, the joystick over the zoom lever, then a held button, the keys, and a
 * gamepad. They are never added together.
 */
export const STEERING_SOURCES = ['surface', 'pad', 'lever', 'hold', 'keys', 'gamepad'] as const;
export type SteeringSource = (typeof STEERING_SOURCES)[number];

/** What each input is asking for now. */
export interface SteeringInputs {
  surface: Steering;
  pad: Steering;
  lever: Steering;
  hold: Steering;
  keys: Steering;
  gamepad: Steering;
}

/** Every input at rest. */
export function stillInputs(): SteeringInputs {
  return { surface: STILL, pad: STILL, lever: STILL, hold: STILL, keys: STILL, gamepad: STILL };
}

/** How fast the arrow keys and the buttons around the joystick steer, and the keys with Shift held. */
export const NUDGE_SPEED = 0.35;
const KEY_SPEED_FAST = 1;
/** How far a stick must be off centre to count: sticks rarely rest at exactly nought. */
const STICK_DEADZONE = 0.15;
/** How much slower steering gets as the camera zooms in: at full zoom, a fifth of the speed. */
const ZOOM_SLOWDOWN = 0.8;

/** The keys that steer while the picture has the focus. */
export const STEERING_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', '_'];

const clamp = (value: number) => Math.min(1, Math.max(-1, value));
const moving = (steering: Steering) =>
  steering.pan !== 0 || steering.tilt !== 0 || steering.zoom !== 0 || steering.focus !== 0;
/** Two decimal places: finer than a camera can tell, and coarse enough that a resting hand isn't a new command. */
const rounded = (value: number) => Math.round(value * 100) / 100;

/** A stick's, a knob's or a pull's deflection made gentler near the centre, so small movements are small. */
export function eased(value: number): number {
  return clamp(value) * Math.abs(clamp(value));
}

/** How far off centre a deflection was before it was eased: where a knob showing a steering sits, -1 to 1. */
export function uneased(value: number): number {
  return Math.sign(value) * Math.sqrt(Math.abs(clamp(value)));
}

/** Whether two steerings ask for the same thing. */
export function sameSteering(one: Steering, other: Steering): boolean {
  return one.pan === other.pan && one.tilt === other.tilt && one.zoom === other.zoom && one.focus === other.focus;
}

/** The input being listened to: the first, in their order, that is steering. */
export function steeringOf(inputs: SteeringInputs): Steering {
  return STEERING_SOURCES.map(source => inputs[source]).find(moving) ?? STILL;
}

/** How much of its speed steering keeps at a zoom, 0 to 1: the further in, the slower, so the picture moves evenly. */
export function slowdownAt(zoom: number | undefined): number {
  return 1 - ZOOM_SLOWDOWN * (zoom ?? 0);
}

/** The `drive` for a steering, on the axes the camera has; null when it comes to no movement at all. */
export function driveOf(steering: Steering, capabilities: CameraCapabilities, slowdown: number): Drive | null {
  // An axis the camera doesn't have is never driven. Focus is only named while it is being driven: a drive that names
  // a focus takes the camera off focusing itself.
  const axis = (has: boolean, velocity: number) => (has ? rounded(velocity) : 0);
  const pan = axis(capabilities.pan !== undefined, steering.pan * slowdown);
  const tilt = axis(capabilities.tilt !== undefined, steering.tilt * slowdown);
  const zoom = axis(capabilities.zoom, steering.zoom);
  const focus = axis(capabilities.focus, steering.focus);
  if (!moving({ pan, tilt, zoom, focus })) return null;
  const drive: Drive = { kind: 'drive', pan, tilt };
  if (capabilities.zoom) drive.zoom = zoom;
  if (focus !== 0) drive.focus = focus;
  return drive;
}

/** How often the loop turns, and so the most often a changed velocity is sent. */
export const TICK_MS = 100;

/** How often an unchanged velocity is sent again: well inside the time the camera's agent waits before stopping it. */
export const REPEAT_MS = 500;

interface Resting {
  status: 'resting';
}

interface Driving {
  status: 'driving';
  /** The drive last sent, as one word to tell a changed one by. */
  sent: string;
  /** When it was sent, in epoch milliseconds. */
  at: number;
}

/**
 * Where the loop that drives the camera is: at rest, with nothing sent that needs stopping, or driving, with a
 * velocity sent that the agent drops unless it is repeated.
 *
 *   resting ── a drive (sends it) ──▶ driving ── no drive (sends `stop`) ──▶ resting
 *                                      │  ▲
 *                                      └──┘  a changed drive, or the same one once REPEAT_MS has passed (sends it)
 */
export type DriveLoop = Resting | Driving;

export const RESTING: DriveLoop = { status: 'resting' };

/** One turn of the loop: where it goes next, and what it sends the camera on the way, if anything. */
export interface DriveStep {
  loop: DriveLoop;
  command: CameraCommand | undefined;
}

/** What the loop does with the drive the steering comes to now: null for no movement at all. */
export function driveStep(loop: DriveLoop, drive: Drive | null, now: number): DriveStep {
  if (drive === null) {
    // Nothing steers: a camera that was being driven is stopped, once.
    return { loop: RESTING, command: loop.status === 'driving' ? { kind: 'stop' } : undefined };
  }
  const sent = JSON.stringify(drive);
  const current = loop.status === 'driving' && loop.sent === sent && now - loop.at < REPEAT_MS;
  if (current) return { loop, command: undefined };
  return { loop: { status: 'driving', sent, at: now }, command: drive };
}

/** The steering the keys held come to. */
export function keySteering(held: ReadonlySet<string>, fast: boolean): Steering {
  const speed = fast ? KEY_SPEED_FAST : NUDGE_SPEED;
  const axis = (positive: string[], negative: string[]) =>
    (positive.some(key => held.has(key)) ? speed : 0) - (negative.some(key => held.has(key)) ? speed : 0);
  return {
    pan: axis(['ArrowRight'], ['ArrowLeft']),
    tilt: axis(['ArrowUp'], ['ArrowDown']),
    zoom: axis(['+', '='], ['-', '_']),
    focus: 0
  };
}

/** A stick's axis, nought inside the deadzone. */
function stick(value: number | undefined): number {
  const deflection = value ?? 0;
  return Math.abs(deflection) < STICK_DEADZONE ? 0 : eased(deflection);
}

/** Whether a gamepad is connected to this browser. Browsers only say so once a button on it has been pressed. */
export function gamepadConnected(): boolean {
  return navigator.getGamepads().some(pad => pad !== null);
}

/**
 * Which of the first connected gamepad's shoulder buttons is held: -1 for the left (L1), 1 for the right (R1), and 0
 * for neither or both. They step between cameras rather than steer one.
 */
export function gamepadShoulder(): number {
  const pad = navigator.getGamepads().find(candidate => candidate !== null);
  if (!pad) return 0;
  return Number(pad.buttons[5]?.pressed ?? false) - Number(pad.buttons[4]?.pressed ?? false);
}

/** The steering the first connected gamepad comes to: left stick steers, triggers zoom, or the right stick does. */
export function gamepadSteering(): Steering {
  const pad = navigator.getGamepads().find(candidate => candidate !== null);
  if (!pad) return STILL;
  const triggers = (pad.buttons[7]?.value ?? 0) - (pad.buttons[6]?.value ?? 0);
  const zoom = Math.abs(triggers) > STICK_DEADZONE ? triggers : -stick(pad.axes[3]);
  return { pan: stick(pad.axes[0]), tilt: -stick(pad.axes[1]), zoom: rounded(zoom), focus: 0 };
}
