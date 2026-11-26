import { chatName } from '@conservationtv/cameras';
import { MAX_SLOTS } from '@conservationtv/shows';
import {
  lineupOf,
  type MemberFact,
  normalised,
  positionedOf,
  stateOf,
  swapped,
  type RankChange,
  type ShowFacts,
  type StreamFact
} from '../shows/resolve.ts';
import { calledIn, cameraNames, onlyOne, type NamedCamera, type Unresolved, unresolved } from './resolve.ts';

/** The quietest and loudest a stream is set to, in decibels, as the show's controls take them. */
const MIN_DB = -60;
const MAX_DB = 12;

/** The word for every stream in the lineup. */
const ALL = 'all';

// What a standard layout or audio command means (docs/shows.md, Chat): the show is the one the triggering agent's
// output follows, read first with what it is resolved from (src/shows/lineup.ts), so this is pure, one step of deciding
// what a use comes to (src/chat/decide.ts). Positions are resolved against the lineup as normalising it leaves it,
// which is what the use writes once its turn is taken, in the transaction that holds the show's row.
//
//   swap          two words, each a stream: `!swap 1 2`, `!swap serval 2`, `!swap serval fox`
//   slots         a number from 0 to 6: the layout, by how many slots it has (packages/shows)
//   scenecams     says what is at each position on screen, or what has taken over
//   takeover      one word, a stream to take over the show with, live at once; or `off`, to end it: not live, and
//                 disarmed
//   livecams      ends the takeover, as `takeover off` does
//   mute, unmute  a stream's channel in the mix, or `all`: every stream in the lineup, and the show's own on unmute
//   setvolume     a stream and a volume in percent of standard (100), as a level in decibels: 20·log10(v / 100)
//   getvolume     says a stream's volume, or `all` in the lineup
//   resetvolume   every stream in the lineup back to standard volume, unmuted
//
// A word that is a whole number is a position in the lineup, from 1. Any other word is a name: a stream's code, its
// name, or its source camera's name or one of its aliases, as chat compares names (`chatName`). A name the lineup
// answers to means that stream, so a camera with streams besides its lineup's is still found; else any of the
// organisation's streams, so a name off the lineup says why it is not in it. A reply names only what the organisation
// has, never what the viewer typed, as for cameras (src/chat/resolve.ts).

/** What a show command changes: ranks in the lineup, the takeover, the lineup's start and the layout, or the mix. */
export type ShowChange = RankChanges | TakeoverChange | SlotsChange | MixChange;

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

/** The layout to set, by how many slots it has. */
export interface SlotsChange {
  kind: 'slots';
  slots: number;
}

/** How streams are mixed in the show, each making its `show_stream` row if it has none; and the show's own mute. */
export interface MixChange {
  kind: 'mix';
  mixes: StreamMixChange[];
  showMuted?: boolean;
}

export interface StreamMixChange {
  streamId: string;
  volumeDb?: number;
  muted?: boolean;
}

/** What a show command means: the change, and what to say in chat once it is made. */
export interface ShowPlan {
  ok: true;
  change: ShowChange;
  reply: string;
}

/** What a show command that changes nothing means: what to say in chat. */
export interface ShowSay {
  ok: true;
  change: null;
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

/** Why a stream cannot be swapped, in words: undefined while it is in the lineup with a position. */
function whyNotInLineup(stream: StreamFact, facts: ShowFacts): string | undefined {
  if (!lineupOf(facts).includes(stream)) return `${stream.name} isn't in the lineup: add it from the show's controls.`;
  // A locked camera keeps its place but is skipped: swapping it would move a blank, not a picture.
  return stateOf(stream, facts) === 'locked' ? `${stream.name} is switched off.` : undefined;
}

/** The lineup stream a word means: a position, or a name of a stream in it. */
function lineupStream(facts: ShowFacts, word: string, cameras: readonly NamedCamera[]): StreamFact | Unresolved {
  if (POSITION.test(word)) {
    const stream = positionedOf(facts)[Number(word) - 1];
    return stream ?? unresolved('There is no camera at that position.');
  }
  const stream = streamCalled(facts, word, cameras, 'camera');
  if ('reply' in stream) return stream;
  const why = whyNotInLineup(stream, facts);
  return why === undefined ? stream : unresolved(why);
}

/** What `swap` means with these words, against the show's facts (normalised here, in memory). */
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
  // Both are in the lineup, so they swap.
  const changes = swapped(facts, { streamId: a.id }, { streamId: b.id }) ?? [];
  return { ok: true, change: { kind: 'ranks', changes }, reply: `Swapped ${a.name} and ${b.name}.` };
}

/** What `takeover` means with these words, against the show's facts. */
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
  const state = stateOf(stream, facts);
  // A camera that is switched off is off every screen, a takeover's too.
  if (state === 'locked' || state === 'disabled') return unresolved(`${stream.name} is switched off.`);
  return {
    ok: true,
    change: { kind: 'takeover', streamId: stream.id, live: true },
    reply: `${stream.name} has taken over.`
  };
}

/** What `slots` means with these words: the layout with that many slots, from none to the most there is. */
export function planSlots(show: ShowFacts, words: readonly string[]): ShowPlan | Unresolved {
  const [word] = words;
  const slots = word !== undefined && POSITION.test(word) ? Number(word) : Number.NaN;
  if (!(slots >= 0 && slots <= MAX_SLOTS)) return unresolved(`Say how many slots, from 0 to ${MAX_SLOTS}.`);
  const noun = slots === 1 ? 'slot' : 'slots';
  if (slots === show.show.slots) return unresolved(`The layout has ${slots} ${noun} already.`);
  return { ok: true, change: { kind: 'slots', slots }, reply: `The layout has ${slots} ${noun}.` };
}

/** What `scenecams` says: what is at each position on screen, or what has taken over. */
export function planSceneCams(show: ShowFacts): ShowSay {
  const facts = normalised(show);
  const { takeoverStreamId, takeoverLive, slots } = facts.show;
  const takenOver = takeoverLive ? facts.streams.find(stream => stream.id === takeoverStreamId) : undefined;
  if (takenOver !== undefined) return { ok: true, change: null, reply: `${takenOver.name} has taken over.` };
  const onScreen = positionedOf(facts).slice(0, slots);
  const reply =
    onScreen.length === 0
      ? 'Nothing is on screen.'
      : `On screen: ${onScreen.map((stream, index) => `${index + 1} ${stream.name}`).join(', ')}.`;
  return { ok: true, change: null, reply };
}

/** What `livecams` means: the end of the takeover. */
export function planLiveCams(show: ShowFacts, cameras: readonly NamedCamera[]): ShowPlan | Unresolved {
  return planShowTakeover(show, [OFF], cameras);
}

/** A stream's channel in the mix: its `show_stream` row's, or standard for one it has none of. */
function mixOf(stream: StreamFact, facts: ShowFacts): Pick<MemberFact, 'volumeDb' | 'muted'> {
  const member = facts.members.find(candidate => candidate.streamId === stream.id);
  return member ?? { volumeDb: 0, muted: false };
}

/** A volume in percent of standard, as a level in decibels, within what the mix takes. */
export function volumeDbOf(percent: number): number {
  if (percent <= 0) return MIN_DB;
  const db = 20 * Math.log10(percent / 100);
  return Math.min(MAX_DB, Math.max(MIN_DB, Math.round(db * 10) / 10));
}

/** A level in decibels, as a volume in percent of standard. */
export function volumePercentOf(volumeDb: number): number {
  return volumeDb <= MIN_DB ? 0 : Math.round(100 * 10 ** (volumeDb / 20));
}

/** The highest volume the mix takes, in percent of standard. */
const MAX_PERCENT = volumePercentOf(MAX_DB);

/** A stream a word means for the mix: a position, or a name, in the lineup or out of it. */
function mixStream(facts: ShowFacts, word: string | undefined, cameras: readonly NamedCamera[]) {
  if (word === undefined) return unresolved('Say which camera, or all.');
  if (POSITION.test(word))
    return positionedOf(facts)[Number(word) - 1] ?? unresolved('There is no camera at that position.');
  return streamCalled(facts, word, cameras, 'camera');
}

/** What `mute` or `unmute` means with these words: a stream's channel, or every one in the lineup with `all`. */
export function planMute(
  show: ShowFacts,
  words: readonly string[],
  cameras: readonly NamedCamera[],
  muted: boolean
): ShowPlan | Unresolved {
  const facts = normalised(show);
  const [word] = words;
  const done = muted ? 'Muted' : 'Unmuted';
  if (word !== undefined && chatName(word) === ALL) {
    const mixes = lineupOf(facts).map(stream => ({ streamId: stream.id, muted }));
    // Unmuting every camera brings the show's own sound back too; muting them leaves it as it is.
    const change: MixChange = muted ? { kind: 'mix', mixes } : { kind: 'mix', mixes, showMuted: false };
    return { ok: true, change, reply: `${done} every camera.` };
  }
  const stream = mixStream(facts, word, cameras);
  if ('reply' in stream) return stream;
  return {
    ok: true,
    change: { kind: 'mix', mixes: [{ streamId: stream.id, muted }] },
    reply: `${done} ${stream.name}.`
  };
}

/** What `setvolume` means with these words: a stream, and its volume in percent of standard. */
export function planSetVolume(
  show: ShowFacts,
  words: readonly string[],
  cameras: readonly NamedCamera[]
): ShowPlan | Unresolved {
  const facts = normalised(show);
  const [word, volume] = words;
  const stream = mixStream(facts, word, cameras);
  if ('reply' in stream) return stream;
  const percent = volume === undefined || !/^\d+$/u.test(volume) ? Number.NaN : Number(volume);
  if (!(percent >= 0 && percent <= MAX_PERCENT))
    return unresolved(`Say a volume from 0 to ${MAX_PERCENT}: 100 is standard.`);
  const volumeDb = volumeDbOf(percent);
  return {
    ok: true,
    change: { kind: 'mix', mixes: [{ streamId: stream.id, volumeDb }] },
    reply: `${stream.name} is at ${volumePercentOf(volumeDb)}%.`
  };
}

/** A stream's volume, as `getvolume` says it. */
function volumeText(stream: StreamFact, facts: ShowFacts): string {
  const { volumeDb, muted } = mixOf(stream, facts);
  return `${stream.name} ${volumePercentOf(volumeDb)}%${muted ? ' (muted)' : ''}`;
}

/** What `getvolume` says: a stream's volume, or every one's in the lineup with `all` or nothing. */
export function planGetVolume(
  show: ShowFacts,
  words: readonly string[],
  cameras: readonly NamedCamera[]
): ShowSay | Unresolved {
  const facts = normalised(show);
  const [word] = words;
  if (word === undefined || chatName(word) === ALL) {
    const lineup = lineupOf(facts);
    const mute = facts.show.muted ? ' The show is muted.' : '';
    const reply =
      lineup.length === 0
        ? 'Nothing is in the lineup.'
        : `${lineup.map(stream => volumeText(stream, facts)).join(', ')}.${mute}`;
    return { ok: true, change: null, reply };
  }
  const stream = mixStream(facts, word, cameras);
  if ('reply' in stream) return stream;
  return { ok: true, change: null, reply: `${volumeText(stream, facts)}.` };
}

/** What `resetvolume` means: every stream in the lineup back to standard volume, unmuted. */
export function planResetVolume(show: ShowFacts): ShowPlan {
  const facts = normalised(show);
  const mixes = lineupOf(facts).map(stream => ({ streamId: stream.id, volumeDb: 0, muted: false }));
  return { ok: true, change: { kind: 'mix', mixes }, reply: 'Every camera is back to standard volume.' };
}
