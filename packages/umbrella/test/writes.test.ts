import { eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { user } from '../src/index.js';
import { assertHolds, rowsStayInScope, staleGrantCannotRecreate } from './support/guarantees.js';
import { useHarness } from './support/harness.js';
import { attempt, Denied, ids, insert, remove, stored, update } from './support/queries.js';
import { orgAdmin, organisation, project, projects, tasks } from './support/schema.js';

const alice = user('alice');

describe('writes', () => {
  const harness = useHarness();

  describe('inserts', () => {
    it('are allowed only into a scope the principal can write', async () => {
      const h = harness();
      await h.secured.access.at(project('apollo')).grant({ principal: alice, role: tasks.$access.roles.editor });
      expect(await insert(h, alice, tasks, { id: 'apollo-2', projectId: 'apollo', title: 'Ok' })).toBe('allowed');
      expect(await insert(h, alice, tasks, { id: 'zeus-2', projectId: 'zeus', title: 'No' })).toBe('denied');
      expect(await stored(h, tasks)).toEqual(['apollo-1', 'apollo-2', 'gemini-1', 'zeus-1']);
    });

    it('store nothing from a batch containing one unauthorized row', async () => {
      const h = harness();
      await h.secured.access.at(project('apollo')).grant({ principal: alice, role: tasks.$access.roles.editor });
      const batch = [
        { id: 'apollo-2', projectId: 'apollo', title: 'Ok' },
        { id: 'zeus-2', projectId: 'zeus', title: 'No' }
      ];
      expect(await insert(h, alice, tasks, batch)).toBe('denied');
      expect(await stored(h, tasks)).toEqual(['apollo-1', 'gemini-1', 'zeus-1']);
    });

    it('create a scope row only with a grant on its parent', async () => {
      const h = harness();
      await h.secured.access.at(organisation('acme')).grant({ principal: alice, role: orgAdmin });
      const hermes = { id: 'hermes', organisationId: 'acme', name: 'Hermes' };
      expect(await insert(h, alice, projects, hermes)).toBe('allowed');
      expect(await insert(h, alice, projects, { ...hermes, id: 'ares', organisationId: 'globex' })).toBe('denied');
    });

    it(staleGrantCannotRecreate.name, () => assertHolds(staleGrantCannotRecreate, harness()));
  });

  describe('updates and deletes', () => {
    it('affect only rows in scopes the principal can write', async () => {
      const h = harness();
      await h.secured.access.at(project('apollo')).grant({ principal: alice, role: tasks.$access.roles.editor });
      const all = inArray(tasks.id, ['apollo-1', 'zeus-1', 'gemini-1']);
      expect(ids(await update(h, alice, tasks, { title: 'Changed' }, all))).toEqual(['apollo-1']);
      const titles = await h.raw.select({ id: tasks.id, title: tasks.title }).from(tasks).orderBy(tasks.id);
      expect(titles).toEqual([
        { id: 'apollo-1', title: 'Changed' },
        { id: 'gemini-1', title: 'Orbit' },
        { id: 'zeus-1', title: 'Strike' }
      ]);
    });

    it('delete only rows in scopes the principal can remove from', async () => {
      const h = harness();
      await h.secured.access.at(project('apollo')).grant({ principal: alice, role: tasks.$access.roles.owner });
      const all = inArray(tasks.id, ['apollo-1', 'zeus-1', 'gemini-1']);
      expect(ids(await remove(h, alice, tasks, all))).toEqual(['apollo-1']);
      expect(await stored(h, tasks)).toEqual(['gemini-1', 'zeus-1']);
    });

    it(rowsStayInScope.name, () => assertHolds(rowsStayInScope, harness()));

    it('cannot move a scope row to another parent', async () => {
      const h = harness();
      for (const id of ['acme', 'globex'])
        await h.secured.access.at(organisation(id)).grant({ principal: alice, role: orgAdmin });
      await expect(
        update(h, alice, projects, { organisationId: 'globex' }, eq(projects.id, 'apollo'))
      ).rejects.toBeInstanceOf(Denied);
      const [row] = await h.raw.select().from(projects).where(eq(projects.id, 'apollo'));
      expect(row?.organisationId).toBe('acme');
    });

    it('cannot change a scope key', async () => {
      const h = harness();
      await h.secured.access.at(organisation('acme')).grant({ principal: alice, role: orgAdmin });
      await expect(update(h, alice, projects, { id: 'renamed' }, eq(projects.id, 'apollo'))).rejects.toBeInstanceOf(
        Denied
      );
      expect(await stored(h, projects)).toContain('apollo');
    });

    it('leave a denied write with no effect', async () => {
      const h = harness();
      expect(await attempt(update(h, alice, tasks, { title: 'Changed' }, eq(tasks.id, 'apollo-1')))).toEqual([]);
      expect(await attempt(remove(h, alice, tasks, eq(tasks.id, 'apollo-1')))).toEqual([]);
      const [task] = await h.raw.select().from(tasks).where(eq(tasks.id, 'apollo-1'));
      expect(task?.title).toBe('Launch');
    });
  });
});
