import { exposureSubject } from '@conservationtv/reports';
import { placedStreams } from '@conservationtv/shows';
import { describe, expect, it } from 'vitest';
import {
  lineupEntries,
  lineupOf,
  neededStreams,
  normalisation,
  normalised,
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

  it('drops the rank of a locked camera, and ranks it last once it is unlocked', () => {
    const base = facts();
    const locked = { ...base, cameras: base.cameras.map(c => (c.id === 'a-camera' ? { ...c, state: 'locked' } : c)) };
    expect(normalisation(locked)).toEqual([{ streamId: 'a', rank: null }]);

    const unlocked = { ...normalised(locked), cameras: base.cameras };
    expect(normalisation(unlocked)).toEqual([{ streamId: 'a', rank: 4 }]);
    expect(ids(lineupOf(normalised(unlocked)))).toEqual(['b', 'c', 'a']);
  });

  it('ranks unranked cameras after the last, oldest first', () => {
    const changes = normalisation(facts({ members: [member('b', 5)] }));
    expect(changes).toEqual([
      { streamId: 'a', rank: 6 },
      { streamId: 'c', rank: 7 }
    ]);
  });

  it('keeps a camera that nothing delivers out of the lineup, saying why', () => {
    const streams = [cameraStream('a', []), cameraStream('b'), cameraStream('c')];
    const normal = normalised(facts({ streams }));
    expect(ids(lineupOf(normal))).toEqual(['b', 'c']);
    expect(lineupEntries(facts({ streams })).map(e => [e.streamId, e.position, e.absence])).toEqual([
      ['b', 1, null],
      ['c', 2, null],
      ['a', null, 'undelivered']
    ]);
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

describe('pushed streams going live', () => {
  it('waits on standby while published, never on air by itself, even with a slot empty', () => {
    const live = liveFacts();
    expect(normalisation(live)).toEqual([]);
    expect(resolveShow(live).cameras.map(camera => camera.streamId)).toEqual(['a', 'b', 'c']);
    expect(lineupEntries(live).map(e => [e.streamId, e.position, e.absence])).toEqual([
      ['a', 1, null],
      ['b', 2, null],
      ['c', 3, null],
      ['phone', null, 'standby']
    ]);
  });

  it("goes on air in a camera's place when swapped with it, the camera rejoining at the end", () => {
    const normal = normalised(liveFacts());
    const changes = swapped(normal, { streamId: 'phone' }, { streamId: 'a' });
    expect(changes).toEqual([
      { streamId: 'phone', rank: 1 },
      { streamId: 'a', rank: null }
    ]);
    const after = normalised(withRanks(normal, changes!));
    expect(ids(lineupOf(after))).toEqual(['phone', 'b', 'c', 'a']);
  });

  it('takes the first empty slot when swapped with one', () => {
    const normal = normalised(liveFacts());
    const changes = swapped(normal, { streamId: 'phone' }, { position: 5 });
    expect(changes).toEqual([{ streamId: 'phone', rank: 4 }]);
    expect(resolveShow(withRanks(normal, changes!)).cameras.map(camera => camera.streamId)).toEqual([
      'a',
      'b',
      'c',
      'phone'
    ]);
    expect(swapped(normal, { streamId: 'phone' }, { position: 7 })).toBeUndefined();
  });

  it('leaves the lineup once nobody publishes it, or health has stopped saying so, and the rest move up', () => {
    const on = withRanks(normalised(liveFacts()), [{ streamId: 'phone', rank: 0 }]);
    expect(ids(lineupOf(on))).toEqual(['phone', 'a', 'b', 'c']);
    for (const state of [deliveryState('phone', 'idle'), deliveryState('phone', 'active', 'stale')]) {
      const off = { ...on, states: [state] };
      expect(normalisation(off)).toEqual([{ streamId: 'phone', rank: null }]);
      expect(ids(lineupOf(normalised(off)))).toEqual(['a', 'b', 'c']);
      expect(lineupEntries(off).some(entry => entry.streamId === 'phone')).toBe(false);
    }
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
