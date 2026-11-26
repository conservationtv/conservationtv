import { describe, expect, it } from 'vitest';
import { planShowSwap, planShowTakeover } from '../../src/chat/shows.ts';
import type { NamedCamera } from '../../src/chat/resolve.ts';
import type { ShowFacts, StreamFact } from '../../src/shows/resolve.ts';

/** A camera's stream, delivered by conservation.tv. */
function cameraStream(id: string, name: string): StreamFact {
  return {
    id,
    name,
    code: null,
    sourceDeviceId: `${id}-camera`,
    exposures: [{ id: `${id}-x`, gatewayId: 'conservationtv' }]
  };
}

const streams = [cameraStream('a', 'Serval'), cameraStream('b', 'Fox'), cameraStream('c', 'Otter')];
const phone: StreamFact = { id: 'phone', name: 'Keeper phone', code: 'KP', sourceDeviceId: null, exposures: [] };

/** The show over three cameras, ranked Serval, Fox, Otter; Otter's camera can be locked. */
function facts(options: { otter?: string; takeoverStreamId?: string | null } = {}): ShowFacts {
  return {
    show: {
      id: 'show',
      organisationId: 'organisation',
      slots: 2,
      volumeDb: 0,
      muted: false,
      takeoverStreamId: options.takeoverStreamId ?? null,
      takeoverLive: false
    },
    streams: [...streams, phone],
    cameras: [
      { id: 'a-camera', state: 'enabled' },
      { id: 'b-camera', state: 'enabled' },
      { id: 'c-camera', state: options.otter ?? 'enabled' }
    ],
    members: streams.map((stream, index) => ({
      streamId: stream.id,
      rank: index + 1,
      volumeDb: 0,
      muted: false,
      syncOffsetMs: 0,
      audioStreamId: null
    })),
    states: []
  };
}

/** The cameras as chat names them: Fox also answers to `vulpes`. */
const cameras: NamedCamera[] = [
  { id: 'a-camera', name: 'Serval', aliases: [], state: 'enabled', presets: [] },
  { id: 'b-camera', name: 'Fox', aliases: ['vulpes'], state: 'enabled', presets: [] },
  { id: 'c-camera', name: 'Otter', aliases: [], state: 'enabled', presets: [] }
];

describe('!swap', () => {
  it('swaps by positions, by names, and by a mix of both', () => {
    const expected = {
      ok: true,
      change: {
        kind: 'ranks',
        changes: [
          { streamId: 'a', rank: 2 },
          { streamId: 'b', rank: 1 }
        ]
      },
      reply: 'Swapped Serval and Fox.'
    };
    expect(planShowSwap(facts(), ['1', '2'], cameras)).toEqual(expected);
    expect(planShowSwap(facts(), ['serval', 'vulpes'], cameras)).toEqual(expected);
    expect(planShowSwap(facts(), ['1', 'FOX'], cameras)).toEqual(expected);
  });

  it('brings a camera off screen on', () => {
    const plan = planShowSwap(facts(), ['otter', '1'], cameras);
    expect(plan).toMatchObject({
      ok: true,
      change: {
        changes: [
          { streamId: 'c', rank: 1 },
          { streamId: 'a', rank: 3 }
        ]
      }
    });
  });

  it('says why it cannot swap', () => {
    const reply = (show: ShowFacts, words: string[]) => (planShowSwap(show, words, cameras) as { reply: string }).reply;
    expect(reply(facts(), ['1'])).toBe('Say which two cameras to swap.');
    expect(reply(facts(), ['1', '9'])).toBe('There is no camera at that position.');
    expect(reply(facts(), ['serval', '1'])).toBe('Those are the same camera.');
    expect(reply(facts(), ['serval', 'badger'])).toBe('There is no camera by that name.');
    expect(reply(facts({ otter: 'locked' }), ['otter', '1'])).toBe('Otter is switched off.');
    expect(reply(facts(), ['kp', '1'])).toBe("Keeper phone isn't live.");
  });
});

describe('!takeover', () => {
  it('takes over, live at once, with any of the organisation’s streams', () => {
    expect(planShowTakeover(facts(), ['kp'], cameras)).toEqual({
      ok: true,
      change: { kind: 'takeover', streamId: 'phone', live: true },
      reply: 'Keeper phone has taken over.'
    });
    expect(planShowTakeover(facts(), ['otter'], cameras)).toMatchObject({ change: { streamId: 'c', live: true } });
  });

  it('ends the takeover, and says so when nothing has taken over', () => {
    expect(planShowTakeover(facts({ takeoverStreamId: 'phone' }), ['Off'], cameras)).toEqual({
      ok: true,
      change: { kind: 'takeover', streamId: null, live: false },
      reply: 'The takeover is over.'
    });
    expect(planShowTakeover(facts(), ['off'], cameras)).toEqual({ ok: false, reply: 'Nothing has taken over.' });
  });

  it('refuses a camera that is switched off, a name nobody has, and no word at all', () => {
    expect(planShowTakeover(facts({ otter: 'disabled' }), ['otter'], cameras)).toEqual({
      ok: false,
      reply: 'Otter is switched off.'
    });
    expect(planShowTakeover(facts(), ['badger'], cameras)).toEqual({
      ok: false,
      reply: 'There is no stream by that name.'
    });
    expect(planShowTakeover(facts(), [], cameras)).toEqual({
      ok: false,
      reply: 'Say which stream takes over, or off.'
    });
  });
});
