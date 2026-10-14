import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { AuthorizationError, roleAssignments, user, withAuthorization } from '../src/index.js';
import { assertHolds, assignmentsHidden, grantsUnforgeable, noPrincipalNoRows } from './support/guarantees.js';
import { appRole, useHarness, type Harness } from './support/harness.js';
import { ids } from './support/queries.js';
import { countries, organisation, project, projects, regions, tables, tasks } from './support/schema.js';

const alice = user('alice');
const count = async (h: Harness, query: string) => {
  const result = await h.secured
    .as(alice)
    .transaction(tx => tx.execute(sql.raw(`select count(*)::int as n from ${query}`)));
  return result.rows[0]?.['n'];
};

describe('row-level security', () => {
  const harness = useHarness();

  describe('joins', () => {
    it('return nothing from a table the principal cannot read', async () => {
      const h = harness();
      await h.secured.access.at(organisation('acme')).grant({ principal: alice, role: tasks.$access.roles.viewer });
      const joined = await h.secured
        .as(alice)
        .transaction(tx =>
          tx.select({ task: tasks.id }).from(tasks).innerJoin(projects, eq(tasks.projectId, projects.id))
        );
      expect(joined).toEqual([]);
    });

    it('return only rows readable on both sides', async () => {
      const h = harness();
      await h.secured.access.at(organisation('acme')).grant({ principal: alice, role: tasks.$access.roles.viewer });
      await h.secured.access.at(project('apollo')).grant({ principal: alice, role: projects.$access.roles.member });
      const joined = await h.secured
        .as(alice)
        .transaction(tx =>
          tx.select({ id: tasks.id }).from(tasks).innerJoin(projects, eq(tasks.projectId, projects.id))
        );
      expect(ids(joined)).toEqual(['apollo-1']);
    });
  });

  it('filters raw SQL', async () => {
    const h = harness();
    await h.secured.access.at(project('apollo')).grant({ principal: alice, role: tasks.$access.roles.viewer });
    expect(await count(h, 'tasks')).toBe(1);
  });

  describe('the assignments table', () => {
    it(assignmentsHidden.name, () => assertHolds(assignmentsHidden, harness()));

    it(grantsUnforgeable.name, () => assertHolds(grantsUnforgeable, harness()));

    it('cannot be used to remove or extend grants', async () => {
      const h = harness();
      await h.secured.access.at(project('apollo')).grant({ principal: alice, role: tasks.$access.roles.viewer });
      await h.secured.as(alice).transaction(async tx => {
        await tx.update(roleAssignments).set({ scopeName: 'global', scopeId: '' });
        await tx.delete(roleAssignments);
      });
      const [grant] = await h.raw.select().from(roleAssignments);
      expect(grant?.scopeName).toBe('project');
    });
  });

  it(noPrincipalNoRows.name, () => assertHolds(noPrincipalNoRows, harness()));

  it('leaves tables without an access definition open', async () => {
    const h = harness();
    expect(await count(h, 'countries')).toBe(1);
    expect(countries).toBeDefined();
  });

  it('closes protected tables that declare no actions', async () => {
    const h = harness();
    await h.secured.access.root().grant({ principal: alice, role: tasks.$access.roles.viewer });
    expect(await count(h, 'regions')).toBe(0);
    expect(regions).toBeDefined();
  });

  it('leaves no principal on the connection after its own transaction ends', async () => {
    const h = harness();
    await h.secured.as(alice).transaction(async () => undefined);
    const result = await h.app.execute(sql`select coalesce(current_setting('authz.principal_kind', true), '') as kind`);
    expect(result.rows[0]).toEqual({ kind: '' });
  });

  it("clears the principal before a caller's transaction resumes", async () => {
    const h = harness();
    const after = await h.app.transaction(async tx => {
      const nested = withAuthorization({ app: tx, admin: h.raw }, { schema: tables });
      await nested.as(alice).transaction(async () => undefined);
      const result = await tx.execute(
        sql`select current_user as role, coalesce(current_setting('authz.principal_kind', true), '') as kind`
      );
      return result.rows[0];
    });
    expect(after).toEqual({ role: appRole, kind: '' });
  });

  describe('an application connection that could bypass the policies', () => {
    const refused = async (h: Harness) => {
      let ran = false;
      await expect(
        h.secured.as(alice).transaction(async tx => {
          ran = true;
          return tx.select().from(tasks);
        })
      ).rejects.toThrow(AuthorizationError);
      expect(ran).toBe(false);
    };

    it('is refused when it logs in as the table owner', async () => {
      const h = harness();
      const misconfigured = withAuthorization({ app: h.raw, admin: h.raw }, { schema: tables });
      await expect(misconfigured.as(alice).transaction(async tx => tx.select().from(tasks))).rejects.toThrow(
        AuthorizationError
      );
    });

    it('is refused when its role has BYPASSRLS', async () => {
      const h = harness();
      await h.pg.exec(`alter role ${appRole} bypassrls`);
      await refused(h);
    });

    it("is refused when its role is a member of the tables' owner", async () => {
      const h = harness();
      await h.pg.exec(`create role owners; alter table tasks owner to owners; grant owners to ${appRole}`);
      await refused(h);
    });
  });

  it('leaves trusted owner connections unrestricted', async () => {
    const h = harness();
    await h.raw.update(tasks).set({ projectId: 'zeus' }).where(eq(tasks.id, 'apollo-1'));
    expect(await h.raw.select().from(tasks)).toHaveLength(3);
  });
});
