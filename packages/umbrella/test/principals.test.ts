import { describe, expect, it } from 'vitest';
import { device as deviceUser, principal, user } from '../src/index.js';
import { useHarness } from './support/harness.js';
import { ids, insert, read, stored } from './support/queries.js';
import { device, readings, tasks } from './support/schema.js';

describe('principal identity', () => {
  const harness = useHarness();

  it('treats a numeric ID and its string form as the same principal', async () => {
    const h = harness();
    await h.secured.access.at(device(1)).grant({ principal: deviceUser(1), role: readings.$access.roles.sensor });
    expect(ids(await read(h, principal('device', '1'), readings))).toEqual(['r1']);
  });

  it('keeps principals of different kinds with the same ID apart', async () => {
    const h = harness();
    await h.secured.access.at(device(1)).grant({ principal: deviceUser(1), role: readings.$access.roles.sensor });
    expect(await read(h, user(1), readings)).toEqual([]);
  });

  it('treats an ID containing SQL as an ordinary value', async () => {
    const h = harness();
    await h.secured.access.root().grant({ principal: user('alice'), role: tasks.$access.roles.viewer });
    expect(await read(h, user("alice' or '1'='1"), tasks)).toEqual([]);
    expect(await read(h, user("x' or principal_id <> '"), tasks)).toEqual([]);
  });

  it("lets a device write only its own scope's rows", async () => {
    const h = harness();
    await h.secured.access.at(device(1)).grant({ principal: deviceUser(1), role: readings.$access.roles.sensor });
    expect(await insert(h, deviceUser(1), readings, { id: 'r3', deviceId: 1, value: 1 })).toBe('allowed');
    expect(await insert(h, deviceUser(1), readings, { id: 'r4', deviceId: 2, value: 1 })).toBe('denied');
    expect(await stored(h, readings)).toEqual(['r1', 'r2', 'r3']);
  });
});

describe('principal validation', () => {
  it.each([
    ['an empty ID', () => user('')],
    ['an empty kind', () => principal('', 'x')],
    ['a kind containing spaces', () => principal('service account', 'x')],
    ['a fractional ID', () => user(1.5)],
    ['an unsafe integer ID', () => user(2 ** 53)]
  ])('rejects %s', (_, create) => {
    expect(create).toThrow(TypeError);
  });
});
