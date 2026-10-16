import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { integer, pgTable, text } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  AuthorizationError,
  rlsMigration,
  roleAssignments,
  user,
  withAccess,
  withAuthorization
} from '../src/index.js';
import { assertHolds, assignmentsHidden, grantsUnforgeable, noPrincipalNoRows } from './support/guarantees.js';
import { appRole, useHarness, type Harness } from './support/harness.js';
import { ids } from './support/queries.js';
import { countries, organisation, project, projects, regions, tables, tasks } from './support/schema.js';

const alice = user('alice');
interface PrivilegeRow {
  ok: boolean;
}
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

  describe('application role privileges', () => {
    // A table exercising every rule: a hidden secret, an immutable column, a generated one and a trusted action.
    const accounts = withAccess(
      pgTable('accounts', {
        id: text().primaryKey(),
        name: text().notNull(),
        secret: text().notNull(),
        createdBy: text('created_by').notNull(),
        size: integer().generatedAlwaysAs(sql`1`)
      }),
      table => ({
        name: 'accounts',
        immutable: [table.createdBy],
        hidden: [table.secret],
        actions: { read: ['select'], create: ['insert'], edit: ['update'], remove: ['delete'] },
        trusted: ['remove']
      })
    );
    const accountsDdl = `create table accounts (
      id text primary key, name text not null, secret text not null, created_by text not null,
      size integer generated always as (1) stored
    )`;
    const privileges = async (migration: string, before = '') => {
      const pg = new PGlite();
      try {
        await pg.exec(await readFile(new URL('../migrations/0000_authz.sql', import.meta.url), 'utf8'));
        await pg.exec(`${accountsDdl}; create role reader; ${before}`);
        await pg.exec(migration);
        const has = async (check: string) => (await pg.query<PrivilegeRow>(`select ${check} as ok`)).rows[0]?.ok;
        return {
          select: await has(`has_table_privilege('reader', 'accounts', 'select')`),
          selectName: await has(`has_column_privilege('reader', 'accounts', 'name', 'select')`),
          selectSecret: await has(`has_column_privilege('reader', 'accounts', 'secret', 'select')`),
          insert: await has(`has_table_privilege('reader', 'accounts', 'insert')`),
          delete: await has(`has_table_privilege('reader', 'accounts', 'delete')`),
          updateName: await has(`has_column_privilege('reader', 'accounts', 'name', 'update')`),
          updateSecret: await has(`has_column_privilege('reader', 'accounts', 'secret', 'update')`),
          updateId: await has(`has_column_privilege('reader', 'accounts', 'id', 'update')`),
          updateCreatedBy: await has(`has_column_privilege('reader', 'accounts', 'created_by', 'update')`),
          updateSize: await has(`has_column_privilege('reader', 'accounts', 'size', 'update')`)
        };
      } finally {
        await pg.close();
      }
    };

    it('follow the definitions: hidden columns unreadable, trusted actions and fixed columns ungranted', async () => {
      expect(await privileges(rlsMigration({ accounts }, { applicationRole: 'reader' }))).toEqual({
        select: false,
        selectName: true,
        selectSecret: false,
        insert: true,
        delete: false,
        updateName: true,
        updateSecret: true,
        updateId: false,
        updateCreatedBy: false,
        updateSize: false
      });
    });

    it('replace whatever the role held before', async () => {
      const migration = rlsMigration({ accounts }, { applicationRole: 'reader' });
      const result = await privileges(
        migration,
        'grant all on accounts to reader; grant select (secret) on accounts to reader'
      );
      expect(result).toMatchObject({ selectSecret: false, delete: false, updateId: false });
    });

    it('are left alone without an application role', async () => {
      const result = await privileges(rlsMigration({ accounts }), 'grant all on accounts to reader');
      expect(result).toMatchObject({ select: true, selectSecret: true, delete: true });
    });

    it('refuse a trusted action that is not declared', () => {
      expect(() =>
        // @ts-expect-error -- `remove` is not an action of this table
        withAccess(pgTable('broken', { id: text().primaryKey() }), () => ({
          name: 'broken',
          actions: { read: ['select'] },
          trusted: ['remove']
        }))
      ).toThrow('Unknown trusted action: remove');
    });
  });
});
