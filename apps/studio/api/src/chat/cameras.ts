import { type CameraCommand, chatName } from '@conservationtv/cameras';
import type { StandardCommandName } from '@conservationtv/chat';
import { normalised, positionedOf, type ShowFacts } from '../shows/resolve.ts';
import { calledIn, cameraNames, type NamedCamera, onlyOne, type Unresolved, unresolved } from './resolve.ts';

// What a standard camera command means (`group: 'camera'` in `@conservationtv/chat`): which camera its first word
// names, and what to tell that camera, or what to say about it. Pure, as the rest of deciding a use is
// (src/chat/decide.ts). The words follow Alveus Sanctuary's commands; the units are turned into the control contract's
// here (packages/cameras/src/contract.ts):
//
//   degrees      pan and tilt, as they are: positive is right and up
//   0 to 100     an absolute zoom or focus, and a point of the picture across and down: a fraction of it, in percent
//   around 100   a relative zoom: 150 zooms in by half the camera's range, 50 out by half, 100 not at all
//
// A camera is named by its name or an alias, or by a position in the lineup of the show the output follows, whose
// camera it is. Only an `enabled` camera is commanded. Whether the camera can take the command (pans, zooms, focuses)
// is its driver's to say: one it can't take is `failed` when carried, and the use's turn is given back.

/** How far a `ptzmove` step goes, in degrees. */
const STEP_DEGREES = 10;

/** One `ptzmove` step: how far it pans and tilts. */
interface Step {
  pan?: number;
  tilt?: number;
}

/** The directions `ptzmove` takes, as the pan and tilt of one step. */
const DIRECTIONS = {
  up: { tilt: STEP_DEGREES },
  down: { tilt: -STEP_DEGREES },
  left: { pan: -STEP_DEGREES },
  right: { pan: STEP_DEGREES },
  upleft: { pan: -STEP_DEGREES, tilt: STEP_DEGREES },
  upright: { pan: STEP_DEGREES, tilt: STEP_DEGREES },
  downleft: { pan: -STEP_DEGREES, tilt: -STEP_DEGREES },
  downright: { pan: STEP_DEGREES, tilt: -STEP_DEGREES }
} as const satisfies Record<string, Step>;

/** A direction `ptzmove` takes. */
type Direction = keyof typeof DIRECTIONS;

/** Whether a word is a direction `ptzmove` takes. */
function isDirection(word: string): word is Direction {
  return Object.hasOwn(DIRECTIONS, word);
}

/** The preset `ptzhome` points a camera at. */
const HOME = 'home';

/** A word that names a position: digits alone. */
const POSITION = /^\d+$/u;
/** A word that is a number: a whole or decimal one, signed or not. */
const NUMBER = /^[-+]?\d+(\.\d+)?$/u;

/** What a camera command comes to: something to say of the camera, or commands to carry to it, said once carried. */
export type CameraEffect = CameraSay | CameraMove;

export interface CameraSay {
  kind: 'say';
  text: string;
}

export interface CameraMove {
  kind: 'move';
  commands: CameraCommand[];
  /** What is said in chat once the camera has taken the commands. */
  text: string;
}

export interface CameraPlan {
  ok: true;
  camera: NamedCamera;
  effect: CameraEffect;
}

/** A number read from a word. */
interface Read {
  ok: true;
  value: number;
}

/** A number a word is, or what to say when it isn't one. */
type Reading = Read | Unresolved;

/** The camera a word names: by name or alias, or by its position in the show's lineup. */
export function cameraCalled(
  word: string | undefined,
  cameras: readonly NamedCamera[],
  show: ShowFacts | undefined
): NamedCamera | Unresolved {
  if (word === undefined) return unresolved('Say which camera.');
  const camera = POSITION.test(word)
    ? cameraAt(Number(word), cameras, show)
    : onlyOne(calledIn(cameras, word, cameraNames), 'camera');
  if ('reply' in camera) return camera;
  return camera.state === 'enabled' ? camera : unresolved(`${camera.name} is switched off.`);
}

/** The camera whose stream is at a position of the show's lineup. */
function cameraAt(position: number, cameras: readonly NamedCamera[], show: ShowFacts | undefined) {
  if (show === undefined) return unresolved('Name the camera: there is no show here to count positions in.');
  const stream = positionedOf(normalised(show))[position - 1];
  if (stream === undefined) return unresolved('There is no camera at that position.');
  const camera = cameras.find(candidate => candidate.id === stream.sourceDeviceId);
  return camera ?? unresolved(`${stream.name} isn't a camera.`);
}

/** The number a word is, within a range: what to say when it is not. */
function numberIn(word: string | undefined, min: number, max: number, what: string): Reading {
  const value = word !== undefined && NUMBER.test(word) ? Number(word) : Number.NaN;
  return value >= min && value <= max ? { ok: true, value } : unresolved(`Say ${what}, from ${min} to ${max}.`);
}

const degrees = (word: string | undefined, what: string) => numberIn(word, -360, 360, `how many degrees to ${what}`);

/** A percentage, as the fraction of a range it is. */
function fraction(word: string | undefined, what: string): Reading {
  const read = numberIn(word, 0, 100, what);
  return read.ok ? { ok: true, value: read.value / 100 } : read;
}

/** A relative zoom around 100, as the fraction of the camera's range to move by. */
function relativeZoom(word: string | undefined): Reading {
  const read = numberIn(word, 0, 200, 'how far to zoom, 100 for none');
  return read.ok ? { ok: true, value: (read.value - 100) / 100 } : read;
}

/** Every reading's value, in order, or what to say of the first that isn't a number. */
function all(...readings: Reading[]): number[] | Unresolved {
  const values: number[] = [];
  for (const reading of readings) {
    if (!reading.ok) return reading;
    values.push(reading.value);
  }
  return values;
}

const move = (camera: NamedCamera, commands: CameraCommand[], text = `Moving ${camera.name}.`): CameraPlan => ({
  ok: true,
  camera,
  effect: { kind: 'move', commands, text }
});

/** Point the camera at the preset by that name. */
function toPreset(camera: NamedCamera, wanted: string | undefined): CameraPlan | Unresolved {
  if (wanted === undefined) return unresolved(`Say where to point ${camera.name}.`);
  const preset = camera.presets.find(candidate => chatName(candidate.name) === chatName(wanted));
  if (preset !== undefined) {
    return move(camera, [{ kind: 'moveTo', ...preset.position }], `Moving ${camera.name} to ${preset.name}.`);
  }
  const which = chatName(wanted) === HOME ? 'home preset' : 'preset by that name';
  return unresolved(`${camera.name} has no ${which}.`);
}

/** Say the camera's presets. */
function listPresets(camera: NamedCamera): CameraPlan {
  const names = camera.presets.map(preset => preset.name);
  const text = names.length === 0 ? `${camera.name} has no presets.` : `${camera.name}: ${names.join(', ')}.`;
  return { ok: true, camera, effect: { kind: 'say', text } };
}

/** Move the camera by what one reading says, on one axis. */
function moveBy(camera: NamedCamera, reading: Reading, axis: 'pan' | 'tilt' | 'zoom'): CameraPlan | Unresolved {
  return reading.ok ? move(camera, [{ kind: 'moveBy', [axis]: reading.value }]) : reading;
}

/** `ptzset`: pan and tilt by degrees, and zoom around 100, at once. */
function setRelative(camera: NamedCamera, [pan, tilt, zoom]: readonly string[]): CameraPlan | Unresolved {
  const values = all(degrees(pan, 'pan'), degrees(tilt, 'tilt'), relativeZoom(zoom));
  if (!Array.isArray(values)) return values;
  const [byPan, byTilt, byZoom] = values;
  return move(camera, [{ kind: 'moveBy', pan: byPan, tilt: byTilt, zoom: byZoom }]);
}

/** `ptzseta`: point at a pan and tilt, a zoom, and a focus when given, all absolute. */
function setAbsolute(camera: NamedCamera, [pan, tilt, zoom, focus]: readonly string[]): CameraPlan | Unresolved {
  const values = all(degrees(pan, 'pan to'), degrees(tilt, 'tilt to'), fraction(zoom, 'how far to zoom'));
  if (!Array.isArray(values)) return values;
  const [toPan, toTilt, toZoom] = values;
  const command: CameraCommand = { kind: 'moveTo', pan: toPan, tilt: toTilt, zoom: toZoom };
  if (focus === undefined) return move(camera, [command]);
  const toFocus = fraction(focus, 'where to focus');
  return toFocus.ok ? move(camera, [{ ...command, focus: toFocus.value }]) : toFocus;
}

/** `ptzmove`: a step in a direction. */
function step(camera: NamedCamera, direction: string | undefined): CameraPlan | Unresolved {
  const wanted = direction?.toLowerCase() ?? '';
  if (!isDirection(wanted)) return unresolved('Say up, down, left, right, upleft, upright, downleft or downright.');
  const by: Step = DIRECTIONS[wanted];
  return move(camera, [{ kind: 'moveBy', ...by }]);
}

/** `ptzcenter`: centre on a point of the picture, then zoom around 100 when a zoom is given. */
function centre(camera: NamedCamera, [x, y, zoom]: readonly string[]): CameraPlan | Unresolved {
  const across = fraction(x, 'how far across');
  if (!across.ok) return across;
  const down = fraction(y, 'how far down');
  if (!down.ok) return down;
  const commands: CameraCommand[] = [{ kind: 'moveToPoint', x: across.value, y: down.value }];
  if (zoom === undefined) return move(camera, commands);
  const by = relativeZoom(zoom);
  if (!by.ok) return by;
  if (by.value !== 0) commands.push({ kind: 'moveBy', zoom: by.value });
  return move(camera, commands);
}

/** `ptzfocusa`: focus, absolutely. */
function focusTo(camera: NamedCamera, [focus]: readonly string[]): CameraPlan | Unresolved {
  const to = fraction(focus, 'where to focus');
  return to.ok ? move(camera, [{ kind: 'moveTo', focus: to.value }], `Focusing ${camera.name}.`) : to;
}

/** What a camera command does with its camera and the words after the camera's. */
type CameraPlanner = (camera: NamedCamera, words: readonly string[]) => CameraPlan | Unresolved;

/** Each camera command's planner, by name. */
const CAMERA_PLANNERS = {
  ptzhome: camera => toPreset(camera, HOME),
  ptzload: (camera, [preset]) => toPreset(camera, preset),
  ptzlist: camera => listPresets(camera),
  ptzpan: (camera, [pan]) => moveBy(camera, degrees(pan, 'pan'), 'pan'),
  ptztilt: (camera, [tilt]) => moveBy(camera, degrees(tilt, 'tilt'), 'tilt'),
  ptzzoom: (camera, [zoom]) => moveBy(camera, relativeZoom(zoom), 'zoom'),
  ptzset: setRelative,
  ptzseta: setAbsolute,
  ptzmove: (camera, [direction]) => step(camera, direction),
  ptzcenter: centre,
  ptzfocusa: focusTo
} as const satisfies Partial<Record<StandardCommandName, CameraPlanner>>;

/** Whether a standard command is one of the camera commands planned here. */
function isCameraCommand(name: StandardCommandName): name is keyof typeof CAMERA_PLANNERS {
  return Object.hasOwn(CAMERA_PLANNERS, name);
}

/** What a standard camera command means with these words: its camera, named by the first, and what to do with it. */
export function planCameraCommand(
  name: StandardCommandName,
  words: readonly string[],
  cameras: readonly NamedCamera[],
  show: ShowFacts | undefined
): CameraPlan | Unresolved {
  if (!isCameraCommand(name)) return unresolved('That is not a camera command.');
  const [word, ...rest] = words;
  const camera = cameraCalled(word, cameras, show);
  if ('reply' in camera) return camera;
  const planner: CameraPlanner = CAMERA_PLANNERS[name];
  return planner(camera, rest);
}
