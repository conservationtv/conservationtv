import {
  placedStreams,
  scenePictures,
  soundSources,
  type BroadcastChannel,
  type BroadcastState,
  type BroadcastStream
} from '@conservationtv/shows';
import type { BuiltinGatewayId } from '../gateways/index.ts';
import { exposureSubject } from '@conservationtv/reports';
import { streamOffline, type StateInput } from '../health/status.ts';

// What a show comes to (docs/shows.md): from its rows in the database and the current state of its organisation's
// streams, read first (src/shows/lineup.ts), the plain state the broadcast is composed from (packages/shows). Pure, as
// a chat command's decision is (src/chat/decide.ts): the same facts come to the same state wherever it is worked out,
// so the show's object composing it, a read authorising what an output plays, and the studio listing the lineup can
// never disagree.
//
// The lineup is the streams the show's operators put in it, in order: `rank` orders it, a stream with no rank is not in
// it. Positions are never stored: position n is the nth stream by rank that is not skipped, and the first `slots` are
// on screen. Only a stream whose camera is locked is skipped, keeping its place to come back to; anything else in the
// lineup stays where it was put, showing its offline card while it has nothing to show (a camera switched off or not
// delivered, a phone that stopped going live), until someone removes it. Streams are added (at the end) and removed by
// the show's controls; the only stream that joins by itself is a camera's new to the show (with no `show_stream` row)
// once it is enabled and delivered, ranked after the last, oldest first, which is all normalising does. Resolving
// normalises in memory; the show's sync writes what normalising changed (src/shows/lineup.ts), so nothing else has to
// remember to.

/** One of a stream's deliveries. */
export interface ExposureFact {
  id: string;
  gatewayId: string;
}

/** One of the organisation's streams: what it is called, where it comes from, and what delivers it. */
export interface StreamFact {
  id: string;
  name: string;
  code: string | null;
  sourceDeviceId: string | null;
  exposures: ExposureFact[];
}

/** One of the organisation's cameras: whether it feeds its streams. */
export interface CameraFact {
  id: string;
  state: string;
}

/** A stream's membership of the show (`show_stream`): its rank, and its channel in the show's mix. */
export interface MemberFact {
  streamId: string;
  rank: number | null;
  volumeDb: number;
  muted: boolean;
  syncOffsetMs: number;
  audioStreamId: string | null;
}

/** The show's own row: its layout, its mix and its takeover. */
export interface ShowFact {
  id: string;
  organisationId: string;
  slots: number;
  volumeDb: number;
  muted: boolean;
  takeoverStreamId: string | null;
  takeoverLive: boolean;
}

/** Everything a show is resolved from, read together. */
export interface ShowFacts {
  show: ShowFact;
  /** The organisation's streams, oldest first. */
  streams: StreamFact[];
  cameras: CameraFact[];
  /** The show's `show_stream` rows. */
  members: MemberFact[];
  /** The states of the streams' sources and deliveries, as `organisations.subjects.states.list` reads them. */
  states: StateInput[];
}

/** Why a stream in the lineup has no position: its camera is locked, so it is skipped, keeping its place. */
export type Absence = 'locked';

/**
 * What a stream not in the lineup would be if it were added: a camera's that is `ready` (enabled and delivered),
 * `locked` (it would be skipped), `disabled` or `undelivered` (it would show its offline card); or a pushed stream that
 * is `live` (someone is publishing it).
 */
export type StreamState = 'ready' | 'locked' | 'disabled' | 'undelivered' | 'live';

/** A rank to write: a stream joining the lineup, or leaving it (null). */
export interface RankChange {
  streamId: string;
  rank: number | null;
}

/** A stream in the lineup, as the show has it: at its position, or skipped and why. */
export interface LineupEntry {
  streamId: string;
  name: string;
  code: string | null;
  /** From 1; null while it is skipped. */
  position: number | null;
  /** Why it is skipped; null while it has a position. */
  absence: Absence | null;
  volumeDb: number;
  muted: boolean;
  syncOffsetMs: number;
  audioStreamId: string | null;
}

/** A stream not in the lineup that could be added: what it is, and what it would be if it were. */
export interface AddableStream {
  streamId: string;
  name: string;
  code: string | null;
  /** Its source: a camera, or none (a phone, a PC, OBS going live). */
  source: 'camera' | 'pushed';
  state: StreamState;
}

/** Which stream a command means: one by its ID, or whichever is at a position of the lineup (from 1). */
export type StreamReference = StreamById | StreamAtPosition;

interface StreamById {
  streamId: string;
}

interface StreamAtPosition {
  position: number;
}

/** The gateway agents built before sources named only their streams read every stream from, by MoQ. */
const LEGACY_GATEWAY: BuiltinGatewayId = 'conservationtv';

/** A stream the show has never been told of: out of the lineup, at standard volume, not muted, with its own sound. */
const STANDARD_MEMBER: Omit<MemberFact, 'streamId'> = {
  rank: null,
  volumeDb: 0,
  muted: false,
  syncOffsetMs: 0,
  audioStreamId: null
};

/** Whether a pushed stream is being published: a delivery of it is active, by a fresh state (src/health/exposure.ts). */
export function published(stream: StreamFact, states: readonly StateInput[]): boolean {
  const subjects = new Set(stream.exposures.map(exposure => exposureSubject(exposure.id)));
  return states.some(
    state => subjects.has(state.subjectId) && state.activity === 'active' && state.freshness === 'fresh'
  );
}

/**
 * What a stream is now, for the lineup: as `StreamState` says. Undefined for a pushed stream nobody is publishing, and
 * one whose source is a device that is not a camera: neither can be added, though either can take over.
 */
export function stateOf(stream: StreamFact, facts: Pick<ShowFacts, 'cameras' | 'states'>): StreamState | undefined {
  if (stream.sourceDeviceId === null) return published(stream, facts.states) ? 'live' : undefined;
  const camera = facts.cameras.find(candidate => candidate.id === stream.sourceDeviceId);
  if (camera === undefined) return undefined;
  if (camera.state === 'locked' || camera.state === 'disabled') return camera.state;
  return stream.exposures.length === 0 ? 'undelivered' : 'ready';
}

/**
 * Whether a stream has nothing to show, whatever its health says: a pushed one nobody is publishing, or a camera's that
 * is not ready. One from a device that is not a camera is left to its health.
 */
function hasNothing(stream: StreamFact, facts: ShowFacts): boolean {
  const state = stateOf(stream, facts);
  if (stream.sourceDeviceId === null) return state !== 'live';
  return state !== undefined && state !== 'ready';
}

/**
 * The ranks normalising the lineup writes: a camera's stream new to the show (with no `show_stream` row) that is ready
 * joins after the last, oldest first; none when there is none.
 */
export function normalisation(facts: ShowFacts): RankChange[] {
  const known = new Set(facts.members.map(member => member.streamId));
  let next = Math.max(0, ...facts.members.map(member => member.rank ?? 0)) + 1;
  // The organisation's streams are oldest first, so the oldest joins first.
  return facts.streams
    .filter(stream => !known.has(stream.id) && stream.sourceDeviceId !== null && stateOf(stream, facts) === 'ready')
    .map(stream => ({ streamId: stream.id, rank: next++ }));
}

/** The facts with `changes` applied to the show's members: a stream new to the show joins with a standard channel. */
export function withRanks(facts: ShowFacts, changes: readonly RankChange[]): ShowFacts {
  const members = new Map(facts.members.map(member => [member.streamId, member]));
  for (const { streamId, rank } of changes) {
    const member = members.get(streamId) ?? { streamId, ...STANDARD_MEMBER };
    members.set(streamId, { ...member, rank });
  }
  return { ...facts, members: [...members.values()] };
}

/** The facts as normalising leaves them. */
export function normalised(facts: ShowFacts): ShowFacts {
  return withRanks(facts, normalisation(facts));
}

/** Every stream in the lineup of normalised facts, skipped ones too, in order: by rank, then oldest first. */
export function lineupOf(facts: ShowFacts): StreamFact[] {
  const ranks = new Map(facts.members.map(member => [member.streamId, member.rank]));
  const order = new Map(facts.streams.map((stream, index) => [stream.id, index]));
  return facts.streams
    .filter(stream => ranks.get(stream.id) != null)
    .sort((a, b) => ranks.get(a.id)! - ranks.get(b.id)! || order.get(a.id)! - order.get(b.id)!);
}

/** Whether a stream in the lineup is skipped: its camera is locked. */
function skipped(stream: StreamFact, facts: ShowFacts): boolean {
  return stateOf(stream, facts) === 'locked';
}

/** The lineup's streams that have positions, in position order: every one but those skipped. */
export function positionedOf(facts: ShowFacts): StreamFact[] {
  return lineupOf(facts).filter(stream => !skipped(stream, facts));
}

/**
 * The stream a reference means in normalised facts' lineup: by its ID (skipped or not), or the stream at a position.
 * Undefined for one not in the lineup, or a position past its end.
 */
export function referencedStream(facts: ShowFacts, reference: StreamReference): StreamFact | undefined {
  if ('position' in reference) return positionedOf(facts)[reference.position - 1];
  return lineupOf(facts).find(stream => stream.id === reference.streamId);
}

/**
 * Exchange two streams' ranks in normalised facts, wherever they are in the lineup: both on screen, or one off it,
 * which is how a stream is brought on. Undefined if either is not in it; none for a stream swapped with itself.
 */
export function swapped(facts: ShowFacts, a: StreamReference, b: StreamReference): RankChange[] | undefined {
  const first = referencedStream(facts, a);
  const second = referencedStream(facts, b);
  if (first === undefined || second === undefined) return undefined;
  if (first.id === second.id) return [];
  const rank = (stream: StreamFact) => facts.members.find(member => member.streamId === stream.id)!.rank;
  return [
    { streamId: first.id, rank: rank(second) },
    { streamId: second.id, rank: rank(first) }
  ];
}

/**
 * Add a stream to the end of normalised facts' lineup: on screen at once if a slot is free. Undefined for one that
 * cannot be added: in the lineup already, a camera's that is locked, a pushed one nobody publishes, or no stream.
 */
export function added(facts: ShowFacts, streamId: string): RankChange[] | undefined {
  const stream = facts.streams.find(candidate => candidate.id === streamId);
  if (stream === undefined || lineupOf(facts).includes(stream)) return undefined;
  const state = stateOf(stream, facts);
  if (state === undefined || state === 'locked') return undefined;
  return [{ streamId, rank: Math.max(0, ...facts.members.map(member => member.rank ?? 0)) + 1 }];
}

/** Take a stream out of normalised facts' lineup: the rest move up. Undefined for one not in it. */
export function removed(facts: ShowFacts, reference: StreamReference): RankChange[] | undefined {
  const stream = referencedStream(facts, reference);
  return stream === undefined ? undefined : [{ streamId: stream.id, rank: null }];
}

/** The lineup as the show has it, in order: each at its position, or skipped and why, with how the show mixes it. */
export function lineupEntries(facts: ShowFacts): LineupEntry[] {
  const normal = normalised(facts);
  const positions = new Map(positionedOf(normal).map((stream, index) => [stream.id, index + 1]));
  return lineupOf(normal).map(stream => {
    const member = normal.members.find(candidate => candidate.streamId === stream.id) ?? STANDARD_MEMBER;
    const { volumeDb, muted, syncOffsetMs, audioStreamId } = member;
    const position = positions.get(stream.id) ?? null;
    const absence = position === null ? ('locked' as const) : null;
    const { name, code } = stream;
    return { streamId: stream.id, name, code, position, absence, volumeDb, muted, syncOffsetMs, audioStreamId };
  });
}

/** The streams that could be added to the lineup, oldest first: as `added` takes them, and locked cameras' too. */
export function addableStreams(facts: ShowFacts): AddableStream[] {
  const normal = normalised(facts);
  const inLineup = new Set(lineupOf(normal).map(stream => stream.id));
  return normal.streams.flatMap(stream => {
    const state = stateOf(stream, normal);
    if (state === undefined || inLineup.has(stream.id)) return [];
    const source = stream.sourceDeviceId === null ? ('pushed' as const) : ('camera' as const);
    return [{ streamId: stream.id, name: stream.name, code: stream.code, source, state }];
  });
}

/** How the show mixes a stream: as `lineupEntries` says it, without where it is in the lineup. */
export interface StreamMix {
  streamId: string;
  name: string;
  code: string | null;
  volumeDb: number;
  muted: boolean;
  syncOffsetMs: number;
  audioStreamId: string | null;
}

/**
 * How the show mixes the stream armed to take over, whether or not it is a camera (a phone's, a PC's or OBS's is in no
 * lineup); null with none armed.
 */
export function takeoverMix(facts: ShowFacts): StreamMix | null {
  const armed = facts.streams.find(stream => stream.id === facts.show.takeoverStreamId);
  if (armed === undefined) return null;
  const member = facts.members.find(candidate => candidate.streamId === armed.id) ?? STANDARD_MEMBER;
  const { volumeDb, muted, syncOffsetMs, audioStreamId } = member;
  return { streamId: armed.id, name: armed.name, code: armed.code, volumeDb, muted, syncOffsetMs, audioStreamId };
}

/**
 * How a stream is mixed in the show: as its member says, or at standard volume, unmuted, with its own sound, when the
 * show has never been told of it. Whose sound it brings is only another of the organisation's streams.
 */
function channelOf(facts: ShowFacts, streamId: string): BroadcastChannel {
  const member = facts.members.find(candidate => candidate.streamId === streamId);
  const { volumeDb, muted, syncOffsetMs, audioStreamId } = member ?? STANDARD_MEMBER;
  const known = audioStreamId !== streamId && facts.streams.some(stream => stream.id === audioStreamId);
  return { volumeDb, muted, syncOffsetMs, from: known ? audioStreamId : null };
}

/**
 * A stream as the broadcast places it, with the card its health chooses: offline while it has nothing to show (a
 * camera's switched off or not delivered, a pushed one nobody publishes), or every delivery is failing.
 */
function broadcastStream(facts: ShowFacts, stream: StreamFact, states: ReadonlyMap<string, StateInput>) {
  const card = hasNothing(stream, facts) || streamOffline(stream, states) ? 'offline' : 'loading';
  const { organisationId } = facts.show;
  return { organisationId, streamId: stream.id, name: stream.name, code: stream.code, card } satisfies BroadcastStream;
}

/**
 * The state the show is composed from: its layout, the lineup's first `slots` streams, its takeover while a stream is
 * armed (any of the organisation's streams can take over), and how each stream it places is mixed: those placed with
 * their pictures, then those a scene places for their sound alone, since a pictured stream brings their sound
 * (`soundSources`, packages/shows).
 */
export function resolveShow(facts: ShowFacts): BroadcastState {
  const normal = normalised(facts);
  const { show } = normal;
  const states = new Map(normal.states.map(state => [state.subjectId, state]));
  const cameras = positionedOf(normal)
    .slice(0, show.slots)
    .map(stream => broadcastStream(normal, stream, states));
  const armed = normal.streams.find(stream => stream.id === show.takeoverStreamId);
  const takeover = armed === undefined ? null : { ...broadcastStream(normal, armed, states), live: show.takeoverLive };
  const scenes = scenePictures({ cameras, takeover });
  const channels = (streamIds: readonly string[]) =>
    Object.fromEntries(streamIds.map(streamId => [streamId, channelOf(normal, streamId)]));
  const pictured = channels([...scenes.main, ...scenes.takeover]);
  const sounds = channels([...soundSources(scenes.main, pictured), ...soundSources(scenes.takeover, pictured)]);
  const audio = { ...pictured, ...sounds };
  const mix = { volumeDb: show.volumeDb, muted: show.muted };
  const exposures = legacyExposures(normal, Object.keys(audio));
  return { slots: show.slots, cameras, takeover, audio, mix, exposures };
}

/**
 * The streams the show needs read, by ID: what it places with its takeover off air, which is the grid's cameras on
 * screen, the armed stream, and each stream one of those brings the sound of. A live takeover releases the grid, but
 * ending it brings the grid straight back, so its cameras are needed all the same.
 */
export function neededStreams(facts: ShowFacts): string[] {
  const offAir = { ...facts, show: { ...facts.show, takeoverLive: false } };
  return placedStreams(resolveShow(offAir));
}

/**
 * Each of these streams' first exposure at conservation.tv, where it has one: what agents built before sources named
 * only their streams read (`exposureId` on packages/shows' `CtvStream`), chosen as they were composed with then.
 */
function legacyExposures(facts: ShowFacts, streamIds: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    streamIds.flatMap(streamId => {
      const stream = facts.streams.find(candidate => candidate.id === streamId);
      const exposure = stream?.exposures.find(candidate => candidate.gatewayId === LEGACY_GATEWAY);
      return exposure === undefined ? [] : [[streamId, exposure.id] as const];
    })
  );
}
