import { chatName, type CameraPosition } from '@conservationtv/cameras';
import type { CameraState } from '../cameras/states.ts';

// Working out what the words that follow a chat command mean: which camera (src/chat/cameras.ts), or which of the
// organisation's streams (src/chat/shows.ts). Pure: what it decides from is read first (src/chat/uses.ts), so it is
// the same decision wherever it is made: one step of deciding what a use of a command comes to (src/chat/decide.ts).
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

// A reply never repeats what the viewer typed: it is said in chat as the broadcaster, so it names only cameras, presets
// and streams the organisation has.

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
