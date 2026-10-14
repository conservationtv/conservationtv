import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { user } from '../src/index.js';
import { useHarness } from './support/harness.js';
import { attempt, ids, insert, read, remove, stored, update } from './support/queries.js';
import { notes, organisation, project, tasks } from './support/schema.js';

const alice = user('alice');
const newTask = { id: 'apollo-2', projectId: 'apollo', title: 'Return' };

describe('role permissions', () => {
  const harness = useHarness();

  describe('a read-only role', () => {
    it('reads', async () => {
      const h = harness();
      await h.secured.access.at(project('apollo')).grant({ principal: alice, role: tasks.$access.roles.viewer });
      expect(ids(await read(h, alice, tasks))).toEqual(['apollo-1']);
    });

    it('cannot insert', async () => {
      const h = harness();
      await h.secured.access.at(project('apollo')).grant({ principal: alice, role: tasks.$access.roles.viewer });
      expect(await insert(h, alice, tasks, newTask)).toBe('denied');
      expect(await stored(h, tasks)).not.toContain('apollo-2');
    });

    it('cannot update', async () => {
      const h = harness();
      await h.secured.access.at(project('apollo')).grant({ principal: alice, role: tasks.$access.roles.viewer });
      expect(await attempt(update(h, alice, tasks, { title: 'Changed' }, eq(tasks.id, 'apollo-1')))).toEqual([]);
      const [task] = await h.raw.select().from(tasks).where(eq(tasks.id, 'apollo-1'));
      expect(task?.title).toBe('Launch');
    });

    it('cannot delete', async () => {
      const h = harness();
      await h.secured.access.at(project('apollo')).grant({ principal: alice, role: tasks.$access.roles.viewer });
      expect(await attempt(remove(h, alice, tasks, eq(tasks.id, 'apollo-1')))).toEqual([]);
      expect(await stored(h, tasks)).toContain('apollo-1');
    });
  });

  describe('a role with write but not remove', () => {
    it('inserts and updates', async () => {
      const h = harness();
      await h.secured.access.at(project('apollo')).grant({ principal: alice, role: tasks.$access.roles.editor });
      expect(await insert(h, alice, tasks, newTask)).toBe('allowed');
      expect(ids(await update(h, alice, tasks, { title: 'Changed' }, eq(tasks.id, 'apollo-1')))).toEqual(['apollo-1']);
    });

    it('cannot delete', async () => {
      const h = harness();
      await h.secured.access.at(project('apollo')).grant({ principal: alice, role: tasks.$access.roles.editor });
      expect(await attempt(remove(h, alice, tasks, eq(tasks.id, 'apollo-1')))).toEqual([]);
      expect(await stored(h, tasks)).toContain('apollo-1');
    });
  });

  it('lets a role with remove delete', async () => {
    const h = harness();
    await h.secured.access.at(project('apollo')).grant({ principal: alice, role: tasks.$access.roles.owner });
    expect(ids(await remove(h, alice, tasks, eq(tasks.id, 'apollo-1')))).toEqual(['apollo-1']);
    expect(await stored(h, tasks)).not.toContain('apollo-1');
  });

  it('never permits an operation the table declares no action for', async () => {
    const h = harness();
    await h.secured.access.at(organisation('acme')).grant({ principal: alice, role: notes.$access.roles.reader });
    expect(await attempt(remove(h, alice, notes, eq(notes.id, 'acme-note')))).toEqual([]);
    expect(await stored(h, notes)).toContain('acme-note');
  });
});
