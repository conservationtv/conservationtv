import { count, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { user } from '../src/index.js';
import { useHarness } from './support/harness.js';
import { ids, read, remove, stored, update } from './support/queries.js';
import { project, tasks } from './support/schema.js';

const alice = user('alice');
/** Filters an application might plausibly write, each of which is true for every row. */
const widening = {
  'a raw OR': sql`${tasks.id} = 'none' or true`,
  'a trailing comment-like OR': sql`false or ${tasks.title} is not null`,
  'a subquery over the same table': sql`exists (select 1 from tasks) or false`
};

describe('application filters only narrow', () => {
  const harness = useHarness();

  describe.each(Object.entries(widening))('with %s', (_, filter) => {
    it('on reads', async () => {
      const h = harness();
      await h.secured.access.at(project('apollo')).grant({ principal: alice, role: tasks.$access.roles.owner });
      expect(ids(await read(h, alice, tasks, filter))).toEqual(['apollo-1']);
    });

    it('on updates', async () => {
      const h = harness();
      await h.secured.access.at(project('apollo')).grant({ principal: alice, role: tasks.$access.roles.owner });
      expect(ids(await update(h, alice, tasks, { title: 'Changed' }, filter))).toEqual(['apollo-1']);
    });

    it('on deletes', async () => {
      const h = harness();
      await h.secured.access.at(project('apollo')).grant({ principal: alice, role: tasks.$access.roles.owner });
      expect(ids(await remove(h, alice, tasks, filter))).toEqual(['apollo-1']);
      expect(await stored(h, tasks)).toEqual(['gemini-1', 'zeus-1']);
    });
  });
});

describe('application filters on counts', () => {
  const harness = useHarness();

  it.each(Object.entries(widening))('only narrow with %s', async (_, filter) => {
    const h = harness();
    await h.secured.access.at(project('apollo')).grant({ principal: alice, role: tasks.$access.roles.viewer });
    const [row] = await h.secured
      .as(alice)
      .transaction(async tx => tx.select({ n: count() }).from(tasks).where(filter));
    expect(row?.n).toBe(1);
  });
});
