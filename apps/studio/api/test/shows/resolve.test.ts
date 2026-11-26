import { exposureSubject } from '@conservationtv/reports';
import { placedStreams } from '@conservationtv/shows';
import { describe, expect, it } from 'vitest';
import {
  addableStreams,
  added,
  lineupEntries,
  lineupOf,
  neededStreams,
  normalisation,
  normalised,
  removed,
  resolveShow,
  swapped,
  withRanks,
  type MemberFact,
  type ShowFacts,
  type StreamFact
} from '../../src/shows/resolve.ts';

/** A camera's stream, delivered by conservation.tv unless told otherwise. */
function cameraStream(id: string, exposures = [{ id: `${id}-exposure`, gatewayId: 'conservationtv' }]): StreamFact {
  return { id, name: id, code: null, sourceDeviceId: `${id}-camera`, exposures };
}

/** A member of the show at a rank, with a standard channel. */
function member(streamId: string, rank: number | null, audioStreamId: string | null = null): MemberFact {
  return { streamId, rank, volumeDb: 0, muted: false, syncOffsetMs: 0, audioStreamId };
}

/** A show of two slots over three enabled cameras, ranked a, b, c, with nothing armed. */
function facts(overrides: Partial<ShowFacts> = {}): ShowFacts {
  const streams = ['a', 'b', 'c'].map(id => cameraStream(id));
  return {
    show: {
      id: 'show',
      organisationId: 'organisation',
      slots: 2,
      volumeDb: 0,
      muted: false,
      takeoverStreamId: null,
      takeoverLive: false
    },
    streams,
    cameras: streams.map(stream => ({ id: stream.sourceDeviceId!, state: 'enabled' })),
    members: [member('a', 1), member('b', 2), member('c', 3)],
    states: [],
    ...overrides
  };
}

const ids = (streams: readonly StreamFact[]) => streams.map(stream => stream.id);

describe('normalising the lineup', () => {
  it('changes nothing when every camera is ranked', () => {
    expect(normalisation(facts())).toEqual([]);
  });

  it('skips a locked camera, which keeps its place and comes back to it once unlocked', () => {
    const base = facts();
    const locked = { ...base, cameras: base.cameras.map(c => (c.id === 'a-camera' ? { ...c, state: 'locked' } : c)) };
    expect(normalisation(locked)).toEqual([]);
    expect(lineupEntries(locked).map(e => [e.streamId, e.position, e.absence])).toEqual([
      ['a', null, 'locked'],
      ['b', 1, null],
      ['c', 2, null]
    ]);
    expect(resolveShow(locked).cameras.map(camera => camera.streamId)).toEqual(['b', 'c']);
    expect(resolveShow(base).cameras.map(camera => camera.streamId)).toEqual(['a', 'b']);
  });

  it('ranks cameras new to the show after the last, oldest first', () => {
    const changes = normalisation(facts({ members: [member('b', 5)] }));
    expect(changes).toEqual([
      { streamId: 'a', rank: 6 },
      { streamId: 'c', rank: 7 }
    ]);
  });

  it('joins a new camera only once it is delivered, but keeps one in the lineup that stops being, on its card', () => {
    const streams = [cameraStream('a', []), cameraStream('b'), cameraStream('c')];
    const fresh = facts({ streams, members: [member('b', 1), member('c', 2)] });
    expect(normalisation(fresh)).toEqual([]);
    expect(addableStreams(fresh).map(s => [s.streamId, s.state])).toEqual([['a', 'undelivered']]);

    const kept = facts({ streams });
    expect(ids(lineupOf(normalised(kept)))).toEqual(['a', 'b', 'c']);
    expect(resolveShow(kept).cameras.map(camera => [camera.streamId, camera.card])).toEqual([
      ['a', 'offline'],
      ['b', 'loading']
    ]);
  });

  it('never ranks a removed camera again by itself', () => {
    const out = facts({ members: [member('a', null), member('b', 2), member('c', 3)] });
    expect(normalisation(out)).toEqual([]);
    expect(ids(lineupOf(out))).toEqual(['b', 'c']);
    expect(addableStreams(out).map(s => [s.streamId, s.source, s.state])).toEqual([['a', 'camera', 'ready']]);
  });

  it('never puts a pushed stream nobody publishes in the lineup', () => {
    const phone: StreamFact = { id: 'phone', name: 'phone', code: null, sourceDeviceId: null, exposures: [] };
    const normal = normalised(facts({ streams: [...facts().streams, phone] }));
    expect(ids(lineupOf(normal))).toEqual(['a', 'b', 'c']);
  });
});

describe('swapping', () => {
  it('exchanges two cameras on screen', () => {
    const normal = normalised(facts());
    const changes = swapped(normal, { position: 1 }, { position: 2 });
    expect(changes).toEqual([
      { streamId: 'a', rank: 2 },
      { streamId: 'b', rank: 1 }
    ]);
    expect(ids(lineupOf(withRanks(normal, changes!)))).toEqual(['b', 'a', 'c']);
  });

  it('brings a camera on screen by swapping it with one off it', () => {
    const normal = normalised(facts());
    const changes = swapped(normal, { streamId: 'c' }, { position: 1 });
    const state = resolveShow(withRanks(normal, changes!));
    expect(state.cameras.map(camera => camera.streamId)).toEqual(['c', 'b']);
  });

  it('refuses a stream not in the lineup, or a position past its end, and does nothing for one with itself', () => {
    const normal = normalised(facts());
    expect(swapped(normal, { position: 1 }, { position: 4 })).toBeUndefined();
    expect(swapped(normal, { streamId: 'nowhere' }, { position: 1 })).toBeUndefined();
    expect(swapped(normal, { streamId: 'a' }, { position: 1 })).toEqual([]);
  });
});

/** A pushed stream (a phone going live), with one delivery at conservation.tv. */
function phoneStream(id = 'phone'): StreamFact {
  return {
    id,
    name: id,
    code: null,
    sourceDeviceId: null,
    exposures: [{ id: `${id}-exposure`, gatewayId: 'conservationtv' }]
  };
}

/** The state of a stream's delivery as health has it: `active` while someone publishes it. */
function deliveryState(streamId: string, activity: 'active' | 'idle', freshness: 'fresh' | 'stale' = 'fresh') {
  return {
    subjectId: exposureSubject(`${streamId}-exposure`),
    health: 'healthy' as const,
    activity,
    freshness,
    observedAt: new Date(),
    state: { findings: [] }
  };
}

/** Six slots over the three cameras, and a phone being published. */
function liveFacts(overrides: Partial<ShowFacts> = {}): ShowFacts {
  const base = facts();
  return facts({
    show: { ...base.show, slots: 6 },
    streams: [...base.streams, phoneStream()],
    states: [deliveryState('phone', 'active')],
    ...overrides
  });
}

describe('adding and removing', () => {
  it('offers a phone while someone publishes it, and adds it at the end: on screen only if a slot is free', () => {
    expect(addableStreams(facts({ streams: [...facts().streams, phoneStream()] }))).toEqual([]);
    const live = liveFacts();
    expect(normalisation(live)).toEqual([]);
    expect(resolveShow(live).cameras.map(camera => camera.streamId)).toEqual(['a', 'b', 'c']);
    expect(addableStreams(live).map(s => [s.streamId, s.source, s.state])).toEqual([['phone', 'pushed', 'live']]);

    const changes = added(normalised(live), 'phone');
    expect(changes).toEqual([{ streamId: 'phone', rank: 4 }]);
    const on = withRanks(live, changes!);
    expect(resolveShow(on).cameras.map(camera => camera.streamId)).toEqual(['a', 'b', 'c', 'phone']);
    expect(addableStreams(on)).toEqual([]);

    const full = withRanks({ ...live, show: { ...live.show, slots: 3 } }, changes!);
    expect(resolveShow(full).cameras.map(camera => camera.streamId)).toEqual(['a', 'b', 'c']);
    expect(lineupEntries(full).at(-1)).toMatchObject({ streamId: 'phone', position: 4, absence: null });
  });

  it('refuses a stream in the lineup already, a locked camera, or a phone nobody publishes', () => {
    const live = normalised(liveFacts());
    expect(added(live, 'a')).toBeUndefined();
    expect(added({ ...live, states: [] }, 'phone')).toBeUndefined();
    const locked = { ...live, cameras: live.cameras.map(c => (c.id === 'a-camera' ? { ...c, state: 'locked' } : c)) };
    const out = withRanks(locked, [{ streamId: 'a', rank: null }]);
    expect(addableStreams(out).find(s => s.streamId === 'a')?.state).toBe('locked');
    expect(added(out, 'a')).toBeUndefined();
  });

  it('keeps a phone that stops being published in its slot, on its offline card, until it is removed', () => {
    const on = withRanks(normalised(liveFacts()), [{ streamId: 'phone', rank: 0 }]);
    const stopped = { ...on, states: [deliveryState('phone', 'idle')] };
    expect(normalisation(stopped)).toEqual([]);
    expect(resolveShow(stopped).cameras.map(camera => [camera.streamId, camera.card])).toEqual([
      ['phone', 'offline'],
      ['a', 'loading'],
      ['b', 'loading'],
      ['c', 'loading']
    ]);
    const changes = removed(stopped, { streamId: 'phone' });
    expect(changes).toEqual([{ streamId: 'phone', rank: null }]);
    expect(ids(lineupOf(withRanks(stopped, changes!)))).toEqual(['a', 'b', 'c']);
    expect(removed(stopped, { streamId: 'nowhere' })).toBeUndefined();
  });

  it('takes a camera out by its position, the rest moving up', () => {
    const normal = normalised(facts());
    const changes = removed(normal, { position: 1 });
    expect(changes).toEqual([{ streamId: 'a', rank: null }]);
    expect(resolveShow(withRanks(normal, changes!)).cameras.map(camera => camera.streamId)).toEqual(['b', 'c']);
  });
});

describe('resolving a show', () => {
  it('places the first `slots` of the lineup, and each mixed as its member says', () => {
    const state = resolveShow(facts());
    expect(state.cameras.map(camera => camera.streamId)).toEqual(['a', 'b']);
    expect(Object.keys(state.audio).sort()).toEqual(['a', 'b']);
    expect(placedStreams(state)).toEqual(['a', 'b']);
  });

  it('places the stream a pictured camera brings the sound of, for its sound alone', () => {
    const state = resolveShow(facts({ members: [member('a', 1, 'c'), member('b', 2), member('c', 3)] }));
    expect(state.audio.a?.from).toBe('c');
    expect(Object.keys(state.audio).sort()).toEqual(['a', 'b', 'c']);
    expect(placedStreams(state).sort()).toEqual(['a', 'b', 'c']);
  });

  it('ignores sound from a stream the organisation does not have', () => {
    const state = resolveShow(facts({ members: [member('a', 1, 'gone'), member('b', 2), member('c', 3)] }));
    expect(state.audio.a?.from).toBeNull();
    expect(placedStreams(state)).toEqual(['a', 'b']);
  });

  it('releases the grid for a live takeover, still placing the armed stream and the sound it brings', () => {
    const phone: StreamFact = { id: 'phone', name: 'phone', code: null, sourceDeviceId: null, exposures: [] };
    const base = facts();
    const live = facts({
      streams: [...base.streams, phone],
      members: [...base.members, member('phone', null, 'c')],
      show: { ...base.show, takeoverStreamId: 'phone', takeoverLive: true }
    });
    const state = resolveShow(live);
    expect(state.takeover).toMatchObject({ streamId: 'phone', live: true });
    // The grid's cameras are still resolved, but a live takeover places none of them.
    expect(state.cameras.map(camera => camera.streamId)).toEqual(['a', 'b']);
    expect(placedStreams(state).sort()).toEqual(['c', 'phone']);
    // Ending the takeover brings the grid straight back, so its cameras are needed all along.
    expect(neededStreams(live).sort()).toEqual(['a', 'b', 'c', 'phone']);
  });

  it('places an armed takeover that is not live beside the grid', () => {
    const base = facts();
    const armed = facts({ show: { ...base.show, takeoverStreamId: 'c', takeoverLive: false } });
    expect(placedStreams(resolveShow(armed)).sort()).toEqual(['a', 'b', 'c']);
  });

  it('cards a stream whose every delivery is failing as offline', () => {
    const failing = {
      subjectId: exposureSubject('a-exposure'),
      health: 'unhealthy' as const,
      activity: 'active' as const,
      freshness: 'fresh' as const,
      observedAt: new Date(),
      state: { findings: [] }
    };
    const state = resolveShow(facts({ states: [failing] }));
    expect(state.cameras.map(camera => [camera.streamId, camera.card])).toEqual([
      ['a', 'offline'],
      ['b', 'loading']
    ]);
  });
});
