import { eq, sql } from 'drizzle-orm';
import { expect } from 'vitest';
import { roleAssignments, user } from '../../src/index.js';
import { type Harness } from './harness.js';
import { Denied, ids, insert, read, stored, update } from './queries.js';
import { VAULT, organisation, project, projects, tasks, vault, vaults } from './schema.js';

/**
 * A security property stated once: `given` arranges grants, `verify` asserts it through the application
 * connection. Tests compose them with healthy and deliberately damaged databases.
 */
export interface Guarantee {
  readonly name: string;
  given(h: Harness): Promise<void>;
  verify(h: Harness): Promise<void>;
}

const alice = user('alice');
const hour = 60 * 60 * 1000;
const nothing = async () => undefined;

export const noGrantsNoRows: Guarantee = {
  name: 'a principal without grants reads nothing',
  given: nothing,
  async verify(h) {
    expect(await read(h, alice, tasks)).toEqual([]);
  }
};

export const projectGrantConfined: Guarantee = {
  name: 'a project grant reaches only that project',
  async given(h) {
    await h.secured.access.at(project('apollo')).grant({ principal: alice, role: tasks.$access.roles.viewer });
  },
  async verify(h) {
    expect(ids(await read(h, alice, tasks))).toEqual(['apollo-1']);
  }
};

export const organisationGrantConfined: Guarantee = {
  name: "an organisation grant reaches its projects and no other organisation's",
  async given(h) {
    await h.secured.access.at(organisation('acme')).grant({ principal: alice, role: tasks.$access.roles.viewer });
  },
  async verify(h) {
    expect(ids(await read(h, alice, tasks))).toEqual(['apollo-1', 'zeus-1']);
  }
};

export const misplacedGrantInert: Guarantee = {
  name: 'a stored grant at a level its role cannot be assigned at gives no access',
  async given(h) {
    await h.raw.insert(roleAssignments).values({
      principalKind: 'user',
      principalId: 'alice',
      resource: 'tasks',
      role: 'owner',
      scopeName: 'global',
      scopeId: ''
    });
  },
  async verify(h) {
    expect(await read(h, alice, tasks)).toEqual([]);
  }
};

export const expiredGrantInert: Guarantee = {
  name: 'an expired grant gives no access',
  async given(h) {
    await h.secured.access
      .at(project('apollo'))
      .grant({ principal: alice, role: tasks.$access.roles.viewer, expiresAt: new Date(Date.now() - hour) });
  },
  async verify(h) {
    expect(await read(h, alice, tasks)).toEqual([]);
  }
};

export const insertConfined: Guarantee = {
  name: 'inserts are confined to writable scopes',
  async given(h) {
    await h.secured.access.at(project('apollo')).grant({ principal: alice, role: tasks.$access.roles.editor });
  },
  async verify(h) {
    expect(await insert(h, alice, tasks, { id: 'zeus-2', projectId: 'zeus', title: 'No' })).toBe('denied');
    expect(await stored(h, tasks)).not.toContain('zeus-2');
  }
};

export const rowsStayInScope: Guarantee = {
  name: 'a row cannot be moved to another scope',
  async given(h) {
    for (const id of ['apollo', 'gemini'])
      await h.secured.access.at(project(id)).grant({ principal: alice, role: tasks.$access.roles.editor });
  },
  async verify(h) {
    await expect(update(h, alice, tasks, { projectId: 'gemini' }, eq(tasks.id, 'apollo-1'))).rejects.toBeInstanceOf(
      Denied
    );
    const [task] = await h.raw.select().from(tasks).where(eq(tasks.id, 'apollo-1'));
    expect(task?.projectId).toBe('apollo');
  }
};

export const staleGrantCannotRecreate: Guarantee = {
  name: 'a stale grant on a deleted key cannot recreate that scope row',
  async given(h) {
    await h.secured.access.at(project('zeus')).grant({ principal: alice, role: projects.$access.roles.lead });
    await h.raw.execute(sql`delete from transfers where from_project_id = 'zeus' or to_project_id = 'zeus'`);
    await h.raw.execute(sql`delete from tasks where project_id = 'zeus'`);
    await h.raw.delete(projects).where(eq(projects.id, 'zeus'));
  },
  async verify(h) {
    expect(await insert(h, alice, projects, { id: 'zeus', organisationId: 'globex', name: 'Hijack' })).toBe('denied');
    expect(await stored(h, projects)).not.toContain('zeus');
  }
};

export const revocationComplete: Guarantee = {
  name: 'revoking at a scope removes access granted there',
  async given(h) {
    await h.secured.access.at(vault(VAULT)).grant({ principal: alice, role: vaults.$access.roles.keeper });
  },
  async verify(h) {
    await h.secured.access.at(vault(VAULT)).revoke({ principal: alice, role: vaults.$access.roles.keeper });
    expect(await read(h, alice, vaults)).toEqual([]);
  }
};

export const assignmentsHidden: Guarantee = {
  name: 'protected sessions cannot read assignments',
  async given(h) {
    await h.secured.access.root().grant({ principal: alice, role: tasks.$access.roles.viewer });
  },
  async verify(h) {
    expect(await h.secured.as(alice).transaction(tx => tx.select().from(roleAssignments))).toEqual([]);
  }
};

export const grantsUnforgeable: Guarantee = {
  name: 'protected sessions cannot grant themselves access',
  given: nothing,
  async verify(h) {
    const forged = {
      principalKind: 'user',
      principalId: 'alice',
      resource: 'tasks',
      role: 'owner',
      scopeName: 'global',
      scopeId: ''
    };
    await expect(h.secured.as(alice).transaction(tx => tx.insert(roleAssignments).values(forged))).rejects.toThrow();
    expect(await h.raw.select().from(roleAssignments)).toEqual([]);
  }
};

export const noPrincipalNoRows: Guarantee = {
  name: 'the application role sees nothing without a principal',
  async given(h) {
    await h.secured.access.root().grant({ principal: alice, role: tasks.$access.roles.viewer });
  },
  async verify(h) {
    const visible = await h.app.select().from(tasks);
    expect(visible).toEqual([]);
  }
};

/** Runs a guarantee end to end in one mode. */
export async function assertHolds(guarantee: Guarantee, h: Harness): Promise<void> {
  await guarantee.given(h);
  await guarantee.verify(h);
}
