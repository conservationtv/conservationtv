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
// The lineup is the show's streams in order. A camera's stream may be in it while its camera is `enabled` and it has at
// least one exposure; a pushed stream (no camera: a phone, a PC, OBS going live) while someone publishes it, as its
// deliveries' health says (src/health/exposure.ts). `rank` orders it; positions are never stored, so position n is
// the nth by rank, and the first `slots` are on screen. Before anything is resolved the lineup is normalised: a ranked
// stream that may no longer be in it loses its rank, and a camera's that may be with none is ranked after the last,
// oldest first. So a camera locked and unlocked comes back last, a new one joins last, and no stale rank survives. A
// pushed stream is never ranked by itself, so it never goes on air by itself: it waits on `standby` until a swap ranks
// it, and loses its rank when it is no longer published. Resolving normalises in memory; the show's sync writes what
// normalising changed (src/shows/lineup.ts), so nothing else has to remember to.

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

/**
 * Why a stream is out of the lineup: its camera is locked or disabled, or nothing delivers it; or, for a pushed stream
 * that is being published, that nobody has swapped it in yet (`standby`).
 */
export type Absence = 'locked' | 'disabled' | 'undelivered' | 'standby';

/** What a stream's place in the lineup is decided by: the cameras, and the states of the streams' deliveries. */
export type LineupFacts = Pick<ShowFacts, 'cameras' | 'states'>;

/** A rank to write: a stream joining the lineup at the end, or leaving it (null). */
export interface RankChange {
  streamId: string;
  rank: number | null;
}

/** One of the organisation's streams as the show has it: in the lineup at its position, or out of it and why. */
export interface LineupEntry {
  streamId: string;
  name: string;
  code: string | null;
  /** From 1, while it is in the lineup. */
  position: number | null;
  /** Why it is out of the lineup; null while it is in it. */
  absence: Absence | null;
  volumeDb: number;
  muted: boolean;
  syncOffsetMs: number;
  audioStreamId: string | null;
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

/** Whether a stream is pushed: it has no source device (a phone, a PC, OBS going live). */
function isPushed(stream: StreamFact): boolean {
  return stream.sourceDeviceId === null;
}

/**
 * Whether a stream may be in the lineup (null), or why a camera's may not. Undefined for one the lineup has nothing to
 * say of: a pushed stream nobody is publishing, or one whose source is a device that is not a camera. Either can still
 * take over. Whether it is ranked is another matter: see `lineupEntries`.
 */
export function absenceOf(stream: StreamFact, facts: LineupFacts): Exclude<Absence, 'standby'> | null | undefined {
  if (isPushed(stream)) return published(stream, facts.states) ? null : undefined;
  const camera = facts.cameras.find(candidate => candidate.id === stream.sourceDeviceId);
  if (camera === undefined) return undefined;
  if (camera.state === 'locked' || camera.state === 'disabled') return camera.state;
  return stream.exposures.length === 0 ? 'undelivered' : null;
}

/**
 * The ranks normalising the lineup writes, in the order above: none when it is already normal. Only a camera's stream
 * is ranked by it; a pushed one keeps whatever rank a swap gave it while it may stay.
 */
export function normalisation(facts: ShowFacts): RankChange[] {
  const eligible = facts.streams.filter(stream => absenceOf(stream, facts) === null);
  const inLineup = new Set(eligible.map(({ id }) => id));
  const rankable = new Set(eligible.filter(stream => !isPushed(stream)).map(({ id }) => id));
  const ranked = facts.members.filter(member => member.rank !== null);
  const leaving = ranked.filter(member => !inLineup.has(member.streamId));
  const staying = ranked.filter(member => inLineup.has(member.streamId));
  const rankedIds = new Set(staying.map(member => member.streamId));
  let next = Math.max(0, ...staying.map(member => member.rank!)) + 1;
  // The organisation's streams are oldest first, so the oldest unranked joins first.
  const joining = [...rankable]
    .filter(streamId => !rankedIds.has(streamId))
    .map(streamId => ({ streamId, rank: next++ }));
  return [...leaving.map(({ streamId }) => ({ streamId, rank: null })), ...joining];
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

/** The lineup of normalised facts, in position order: by rank, then oldest first. */
export function lineupOf(facts: ShowFacts): StreamFact[] {
  const ranks = new Map(facts.members.map(member => [member.streamId, member.rank]));
  const order = new Map(facts.streams.map((stream, index) => [stream.id, index]));
  return facts.streams
    .filter(stream => absenceOf(stream, facts) === null && ranks.get(stream.id) != null)
    .sort((a, b) => ranks.get(a.id)! - ranks.get(b.id)! || order.get(a.id)! - order.get(b.id)!);
}

/** The pushed streams of normalised facts that are published but not ranked: on `standby`, oldest first. */
export function standbyOf(facts: ShowFacts): StreamFact[] {
  const ranks = new Map(facts.members.map(member => [member.streamId, member.rank]));
  return facts.streams.filter(
    stream => isPushed(stream) && absenceOf(stream, facts) === null && ranks.get(stream.id) == null
  );
}

/**
 * The stream a reference means in normalised facts: one in the lineup, by its ID or its position, or one on standby,
 * by its ID. Undefined for any other, or a position past the lineup's end.
 */
export function referencedStream(facts: ShowFacts, reference: StreamReference): StreamFact | undefined {
  const lineup = lineupOf(facts);
  if ('position' in reference) return lineup[reference.position - 1];
  return [...lineup, ...standbyOf(facts)].find(stream => stream.id === reference.streamId);
}

/** Whether a reference is to an empty slot: a position past the lineup's end that is still on screen. */
function emptySlot(facts: ShowFacts, reference: StreamReference): boolean {
  return (
    'position' in reference && reference.position > lineupOf(facts).length && reference.position <= facts.show.slots
  );
}

/**
 * Exchange two streams' ranks in normalised facts, wherever they are in the lineup: both on screen, or one off it,
 * which is how a camera is brought on. A stream on standby swapped with one in the lineup takes its place, and the
 * other leaves it: a camera's rejoins at the end, a pushed one goes back to standby. A stream swapped with an empty
 * slot is ranked after the last, so it takes the first empty slot. Undefined if either is neither; none for a stream
 * swapped with itself.
 */
export function swapped(facts: ShowFacts, a: StreamReference, b: StreamReference): RankChange[] | undefined {
  const rank = (stream: StreamFact) => facts.members.find(member => member.streamId === stream.id)?.rank ?? null;
  const last = () => Math.max(0, ...facts.members.map(member => member.rank ?? 0));
  for (const [stream, slot] of [
    [a, b],
    [b, a]
  ] as const) {
    const moving = referencedStream(facts, stream);
    if (moving !== undefined && emptySlot(facts, slot)) return [{ streamId: moving.id, rank: last() + 1 }];
  }
  const first = referencedStream(facts, a);
  const second = referencedStream(facts, b);
  if (first === undefined || second === undefined) return undefined;
  if (first.id === second.id) return [];
  return [
    { streamId: first.id, rank: rank(second) },
    { streamId: second.id, rank: rank(first) }
  ];
}

/**
 * Every stream the lineup has something to say of, as the show has it: the lineup in order, then the pushed streams on
 * standby, then the cameras' streams out of it, with why.
 */
export function lineupEntries(facts: ShowFacts): LineupEntry[] {
  const normal = normalised(facts);
  const lineup = lineupOf(normal);
  const standby = standbyOf(normal).map(stream => ({ stream, absence: 'standby' as const }));
  const out = normal.streams.flatMap(stream => {
    const absence = absenceOf(stream, normal);
    return absence === undefined || absence === null ? [] : [{ stream, absence }];
  });
  const entry = (stream: StreamFact, position: number | null, absence: Absence | null): LineupEntry => {
    const member = normal.members.find(candidate => candidate.streamId === stream.id) ?? STANDARD_MEMBER;
    const { volumeDb, muted, syncOffsetMs, audioStreamId } = member;
    const { name, code } = stream;
    return { streamId: stream.id, name, code, position, absence, volumeDb, muted, syncOffsetMs, audioStreamId };
  };
  return [
    ...lineup.map((stream, index) => entry(stream, index + 1, null)),
    ...[...standby, ...out].map(({ stream, absence }) => entry(stream, null, absence))
  ];
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

/** A stream as the broadcast places it, with the card its health chooses. */
function broadcastStream(facts: ShowFacts, stream: StreamFact, states: ReadonlyMap<string, StateInput>) {
  const card = streamOffline(stream, states) ? 'offline' : 'loading';
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
  const cameras = lineupOf(normal)
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
