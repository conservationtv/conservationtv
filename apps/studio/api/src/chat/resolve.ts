import { chatName, type CameraPosition } from '@conservationtv/cameras';
import type { CameraState } from '../cameras/states.ts';
import type { CameraPresetAction } from './commands.ts';

// Working out which camera and preset a chat command means, from the words that follow it. Pure: what it decides from
// is read first (src/services/chat-commands.ts), so it is the same decision wherever it is made: one step of deciding
// what a use of a command comes to (src/chat/decide.ts).

/** A preset, as chat finds it. */
export interface NamedPreset {
  name: string;
  position: CameraPosition;
}

/** A camera, as chat finds it: by its name or an alias, with the presets it can be pointed at. */
export interface NamedCamera {
  id: string;
  name: string;
  aliases: string[];
  state: CameraState;
  presets: NamedPreset[];
}

/** What the command means, or what to say when it means nothing. */
export type Resolution = Resolved | Unresolved;

interface Resolved {
  ok: true;
  camera: NamedCamera;
  preset: NamedPreset;
}

interface Unresolved {
  ok: false;
  reply: string;
}

const unresolved = (reply: string): Unresolved => ({ ok: false, reply });

/** The cameras called this in chat: by name or alias, compared as `chatName` does. */
function camerasCalled(cameras: readonly NamedCamera[], word: string): NamedCamera[] {
  const wanted = chatName(word);
  if (wanted === '') return [];
  return cameras.filter(camera => [camera.name, ...camera.aliases].some(name => chatName(name) === wanted));
}

/** The camera the command is for: the one it names, or the one its first word does. */
function resolveCamera(action: CameraPresetAction, cameras: readonly NamedCamera[], word: string | undefined) {
  if (action.cameraId !== null) {
    const camera = cameras.find(candidate => candidate.id === action.cameraId);
    return camera ?? unresolved('That camera is no longer here.');
  }
  if (word === undefined) return unresolved('Say which camera.');
  const called = camerasCalled(cameras, word);
  if (called.length > 1) return unresolved(`More than one camera is called ${word}.`);
  return called[0] ?? unresolved(`There is no camera called ${word}.`);
}

/**
 * The camera and preset a `cameraPreset` command means, given the words that followed it: whichever of the two the
 * command leaves open is taken from them, the camera first.
 */
export function resolveCameraPreset(
  action: CameraPresetAction,
  words: readonly string[],
  cameras: readonly NamedCamera[]
): Resolution {
  const remaining = [...words];
  const camera = resolveCamera(action, cameras, action.cameraId === null ? remaining.shift() : undefined);
  if ('reply' in camera) return camera;
  if (camera.state !== 'enabled') return unresolved(`${camera.name} is switched off.`);
  const wanted = action.preset ?? remaining.shift();
  if (wanted === undefined) return unresolved(`Say where to point ${camera.name}.`);
  const preset = camera.presets.find(candidate => chatName(candidate.name) === chatName(wanted));
  if (preset === undefined) return unresolved(`${camera.name} has no preset called ${wanted}.`);
  return { ok: true, camera, preset };
}
