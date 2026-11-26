import { chatName } from '@conservationtv/cameras';
import {
  absenceOf,
  lineupOf,
  normalised,
  swapped,
  type RankChange,
  type ShowFacts,
  type StreamFact
} from '../shows/resolve.ts';
import { calledIn, cameraNames, onlyOne, type NamedCamera, type Unresolved, unresolved } from './resolve.ts';

// What a chat command for a show means (docs/shows.md, Chat): the show is the one the triggering agent's output
// follows, read first with what it is resolved from (src/shows/lineup.ts), so this is pure, one step of deciding what
// a use comes to (src/chat/decide.ts). Positions are resolved against the lineup as normalising it leaves it, which is
// what the use writes once its turn is taken, in the transaction that holds the show's row.
//
//   showSwap      two words, each a stream: `!swap 1 2`, `!swap serval 2`, `!swap serval fox`
//   showTakeover  one word, a stream to take over the show with, live at once; or `off`, to end it: not live, and
//                 disarmed
//
// A word that is a whole number is a position in the lineup, from 1. Any other word is a name: a stream's code, its
// name, or its source camera's name or one of its aliases, as chat compares names (`chatName`). A name the lineup
// answers to means that stream, so a camera with streams besides its lineup's is still found; else any of the
// organisation's streams, so a name off the lineup says why it is not in it. A reply names only what the organisation
// has, never what the viewer typed, as for cameras (src/chat/resolve.ts).

/** What a show command changes: ranks in the lineup, or the takeover. */
export type ShowChange = RankChanges | TakeoverChange;

/** Ranks to write into the lineup, normalised first. */
export interface RankChanges {
  kind: 'ranks';
  changes: RankChange[];
}

/** The takeover to set: the stream armed (null for none), and whether it is on air. */
export interface TakeoverChange {
  kind: 'takeover';
  streamId: string | null;
  live: boolean;
}

/** What a show command means: the change, and what to say in chat once it is made. */
export interface ShowPlan {
  ok: true;
  change: ShowChange;
  reply: string;
}

/** The word that ends a takeover. */
const OFF = 'off';

/** A word that names a position: digits alone. */
const POSITION = /^\d+$/u;

/** The names a stream answers to in chat: its code, its name, and its source camera's names. */
function streamNames(stream: StreamFact, cameras: readonly NamedCamera[]): string[] {
  const camera = cameras.find(candidate => candidate.id === stream.sourceDeviceId);
  const code = stream.code === null ? [] : [stream.code];
  return [...code, stream.name, ...(camera === undefined ? [] : cameraNames(camera))];
}

/** The stream a name means: the lineup's, if it answers to it, else any of the organisation's. */
function streamCalled(facts: ShowFacts, word: string, cameras: readonly NamedCamera[], noun: string) {
  const namesOf = (stream: StreamFact) => streamNames(stream, cameras);
  const inLineup = calledIn(lineupOf(facts), word, namesOf);
  if (inLineup.length > 0) return onlyOne(inLineup, noun);
  return onlyOne(calledIn(facts.streams, word, namesOf), noun);
}

/** Why a stream cannot be swapped, in words: undefined while it is in the lineup or on standby. */
function whyNotInLineup(stream: StreamFact, facts: ShowFacts): string | undefined {
  const absence = absenceOf(stream, facts);
  if (absence === null) return undefined;
  if (absence === undefined && stream.sourceDeviceId === null) return `${stream.name} isn't live.`;
  if (absence === undefined) return `${stream.name} isn't one of the cameras.`;
  if (absence === 'undelivered') return `${stream.name} isn't being delivered.`;
  return `${stream.name} is switched off.`;
}

/** The lineup stream a word means: a position, or a name of a stream in it. */
function lineupStream(facts: ShowFacts, word: string, cameras: readonly NamedCamera[]): StreamFact | Unresolved {
  if (POSITION.test(word)) {
    const stream = lineupOf(facts)[Number(word) - 1];
    return stream ?? unresolved('There is no camera at that position.');
  }
  const stream = streamCalled(facts, word, cameras, 'camera');
  if ('reply' in stream) return stream;
  const why = whyNotInLineup(stream, facts);
  return why === undefined ? stream : unresolved(why);
}

/** What `showSwap` means with these words, against the show's facts (normalised here, in memory). */
export function planShowSwap(
  show: ShowFacts,
  words: readonly string[],
  cameras: readonly NamedCamera[]
): ShowPlan | Unresolved {
  const facts = normalised(show);
  const [first, second] = words;
  if (first === undefined || second === undefined) return unresolved('Say which two cameras to swap.');
  const a = lineupStream(facts, first, cameras);
  if ('reply' in a) return a;
  const b = lineupStream(facts, second, cameras);
  if ('reply' in b) return b;
  if (a.id === b.id) return unresolved('Those are the same camera.');
  // Each is in the lineup or on standby, so they swap.
  const changes = swapped(facts, { streamId: a.id }, { streamId: b.id }) ?? [];
  return { ok: true, change: { kind: 'ranks', changes }, reply: `Swapped ${a.name} and ${b.name}.` };
}

/** What `showTakeover` means with these words, against the show's facts. */
export function planShowTakeover(
  show: ShowFacts,
  words: readonly string[],
  cameras: readonly NamedCamera[]
): ShowPlan | Unresolved {
  const [word] = words;
  if (word === undefined) return unresolved('Say which stream takes over, or off.');
  if (chatName(word) === OFF) {
    if (show.show.takeoverStreamId === null) return unresolved('Nothing has taken over.');
    return { ok: true, change: { kind: 'takeover', streamId: null, live: false }, reply: 'The takeover is over.' };
  }
  const facts = normalised(show);
  const stream = streamCalled(facts, word, cameras, 'stream');
  if ('reply' in stream) return stream;
  const absence = absenceOf(stream, facts);
  // A camera that is switched off is off every screen, a takeover's too.
  if (absence === 'locked' || absence === 'disabled') return unresolved(`${stream.name} is switched off.`);
  return {
    ok: true,
    change: { kind: 'takeover', streamId: stream.id, live: true },
    reply: `${stream.name} has taken over.`
  };
}
