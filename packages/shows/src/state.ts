// The state a broadcast is composed from (docs/shows.md): plain data the studio API resolves from a show's rows in the
// database and the current state of its organisation's streams (src/shows in the studio API). It names streams, never
// how they are delivered: each reader finds its own delivery when it plays one.

/** What a stream shows under its video, whenever the video has no picture. */
export type BroadcastCard = 'loading' | 'offline';

/** A stream the broadcast places: which, what it is called, and the card under its video. */
export interface BroadcastStream {
  organisationId: string;
  streamId: string;
  name: string;
  /** Its short code, at most four characters, if it has one. */
  code: string | null;
  /** What is under its video: shown whenever the video has no picture. */
  card: BroadcastCard;
}

/** The armed takeover source, and whether it is on air. */
export interface BroadcastTakeover extends BroadcastStream {
  live: boolean;
}

/** How one stream is mixed in the show: its level, whether it is muted, how far its sound is shifted, and from where. */
export interface BroadcastChannel {
  volumeDb: number;
  muted: boolean;
  syncOffsetMs: number;
  /** The stream whose sound it brings: null for its own. */
  from: string | null;
}

/** The show's own mix, over every channel. */
export interface BroadcastMix {
  volumeDb: number;
  muted: boolean;
}

/** Everything the broadcast is composed from. */
export interface BroadcastState {
  /** The layout: 0 to 6 (src/layouts.ts). */
  slots: number;
  /** The lineup's first `slots` streams, in position order. Fewer leaves empty slots. */
  cameras: BroadcastStream[];
  /** The armed takeover source, and whether it is on air. */
  takeover: BroadcastTakeover | null;
  /**
   * How each stream that can be heard is mixed, by stream ID: every stream placed with its picture, and every stream
   * placed for its sound alone (`soundSources`). A stream whose sound comes `from` another is placed without its own.
   */
  audio: Record<string, BroadcastChannel>;
  /** The show's own mix: its level over every channel, and whether all of it is muted. */
  mix: BroadcastMix;
  /**
   * Deprecated: each placed stream's conservation.tv exposure, by stream ID, where it has one, for agents built before
   * a source named only its stream (`exposureId` on `CtvStream`). Nothing since reads it.
   */
  exposures?: Record<string, string>;
}

/** The streams each scene places with their pictures. */
export interface ScenePictures {
  /** The grid's cameras, unless a takeover is live, which releases them. */
  main: string[];
  /** The armed takeover source, on air or not. */
  takeover: string[];
}

/** The streams each scene places with their pictures, by ID: the grid unless a takeover is live, and the takeover. */
export function scenePictures(state: Pick<BroadcastState, 'cameras' | 'takeover'>): ScenePictures {
  const main = state.takeover?.live ? [] : state.cameras.map(camera => camera.streamId);
  const takeover = state.takeover === null ? [] : [state.takeover.streamId];
  return { main, takeover };
}

/** Whose sound a stream placed with its picture brings: undefined for its own. */
export function soundFrom(audio: Readonly<Record<string, BroadcastChannel>>, streamId: string): string | undefined {
  const from = audio[streamId]?.from ?? null;
  return from === null || from === streamId ? undefined : from;
}

/**
 * The streams a scene places for their sound alone, by ID, given the streams it places with their pictures: each one
 * whose sound a pictured stream brings, once, unless the scene already hears it with its picture.
 */
export function soundSources(pictures: readonly string[], audio: Readonly<Record<string, BroadcastChannel>>): string[] {
  const heard = new Set(pictures.filter(streamId => soundFrom(audio, streamId) === undefined));
  const brought = pictures.flatMap(streamId => soundFrom(audio, streamId) ?? []);
  return [...new Set(brought)].filter(streamId => !heard.has(streamId));
}

/**
 * The streams a state places, by ID: the takeover source while one is armed, the grid's cameras unless a takeover is
 * live, which releases them, and each stream either scene places for its sound alone. What an output may read is
 * authorised from this, so the composition and the reads cannot drift.
 */
export function placedStreams(state: BroadcastState): string[] {
  const { main, takeover } = scenePictures(state);
  const sounds = [...soundSources(main, state.audio), ...soundSources(takeover, state.audio)];
  return [...new Set([...main, ...takeover, ...sounds])];
}
