import { chatName, type CameraPosition } from '@conservationtv/cameras';
import type { CameraState } from '../cameras/states.ts';
import type { CameraPresetAction } from './commands.ts';

// Working out what the words that follow a chat command mean: which camera and preset, or which of the organisation's
// streams (src/chat/shows.ts). Pure: what it decides from is read first (src/services/chat-commands.ts), so it is the
// same decision wherever it is made: one step of deciding what a use of a command comes to (src/chat/decide.ts).
// Whatever is found by name is found the same way: by any of the names it answers to, compared as `chatName` compares
// them, with the same replies when no one or more than one answers.

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

/**
 * What the command means, or what to say when it means nothing. A reply never repeats what the viewer typed: it is said
 * in chat as the broadcaster, so it names only cameras and presets the organisation has.
 */
export type Resolution = Resolved | Unresolved;

interface Resolved {
  ok: true;
  camera: NamedCamera;
  preset: NamedPreset;
}

/** Words that mean nothing it can do: what to say about them. */
export interface Unresolved {
  ok: false;
  reply: string;
}

export const unresolved = (reply: string): Unresolved => ({ ok: false, reply });

/** Of `candidates`, those called `word` in chat: by any of the names each answers to, compared as `chatName` does. */
export function calledIn<Candidate>(
  candidates: readonly Candidate[],
  word: string,
  namesOf: (candidate: Candidate) => readonly string[]
): Candidate[] {
  const wanted = chatName(word);
  if (wanted === '') return [];
  return candidates.filter(candidate => namesOf(candidate).some(name => chatName(name) === wanted));
}

/** The one of `called` (`calledIn`), or what to say when there is none, or more than one: each is a `noun`. */
export function onlyOne<Candidate>(called: readonly Candidate[], noun: string): Candidate | Unresolved {
  if (called.length > 1) return unresolved(`More than one ${noun} has that name.`);
  return called[0] ?? unresolved(`There is no ${noun} by that name.`);
}

/** The names a camera answers to in chat: its name and its aliases. */
export function cameraNames(camera: Pick<NamedCamera, 'name' | 'aliases'>): string[] {
  return [camera.name, ...camera.aliases];
}

/** The camera the command is for: the one it names, or the one its first word does. */
function resolveCamera(action: CameraPresetAction, cameras: readonly NamedCamera[], word: string | undefined) {
  if (action.cameraId !== null) {
    const camera = cameras.find(candidate => candidate.id === action.cameraId);
    return camera ?? unresolved('That camera is no longer here.');
  }
  if (word === undefined) return unresolved('Say which camera.');
  return onlyOne(calledIn(cameras, word, cameraNames), 'camera');
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
  if (preset === undefined) return unresolved(`${camera.name} has no preset by that name.`);
  return { ok: true, camera, preset };
}
