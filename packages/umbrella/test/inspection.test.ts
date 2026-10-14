import { describe, expect, it } from 'vitest';
import { user, type Principal } from '../src/index.js';
import { useHarness } from './support/harness.js';
import { VAULT, auditor, orgAdmin, organisation, project, tasks, vault, vaults } from './support/schema.js';
import { read } from './support/queries.js';

const alice = user('alice');
const bob = user('bob');
const carol = user('carol');
const hour = 60 * 60 * 1000;

describe('inspection agrees with enforcement', () => {
  const harness = useHarness();

  it('for every principal, project, and action', async () => {
    const h = harness();
    await h.secured.access.at(organisation('acme')).grant({ principal: alice, role: orgAdmin });
    await h.secured.access.at(project('gemini')).grant({ principal: bob, role: tasks.$access.roles.editor });
    await h.secured.access.root().grant({ principal: carol, role: auditor });
    await h.secured.access
      .at(project('zeus'))
      .grant({ principal: carol, role: tasks.$access.roles.owner, expiresAt: new Date(Date.now() - hour) });

    const projectsWithTasks: [string, string][] = [
      ['apollo', 'apollo-1'],
      ['zeus', 'zeus-1'],
      ['gemini', 'gemini-1']
    ];
    for (const who of [alice, bob, carol, user('nobody')] satisfies Principal[]) {
      const readable = (await read(h, who, tasks)).map(row => row.id);
      for (const [id, task] of projectsWithTasks) {
        const report = await h.secured.access.inspect({ principal: who, resource: tasks, scope: project(id) });
        expect(report.permissions['read']?.allowed, `${who.id} reads ${id}`).toBe(readable.includes(task));
      }
    }
  });
});

describe('inspection', () => {
  const harness = useHarness();

  it('reports inactive grants without counting them', async () => {
    const h = harness();
    await h.secured.access
      .at(project('apollo'))
      .grant({ principal: alice, role: tasks.$access.roles.owner, expiresAt: new Date(Date.now() - hour) });
    const report = await h.secured.access.inspect({ principal: alice, resource: tasks, scope: project('apollo') });
    expect(report.roles.map(role => role.status)).toEqual(['expired']);
    expect(Object.values(report.permissions).some(permission => permission.allowed)).toBe(false);
  });

  it('marks grants from ancestor scopes as inherited', async () => {
    const h = harness();
    await h.secured.access.at(organisation('acme')).grant({ principal: alice, role: orgAdmin });
    await h.secured.access.at(project('apollo')).grant({ principal: alice, role: tasks.$access.roles.viewer });
    const report = await h.secured.access.inspect({ principal: alice, resource: tasks, scope: project('apollo') });
    expect(report.roles.map(role => [role.role, role.inherited]).sort()).toEqual([
      ['orgAdmin', true],
      ['viewer', false]
    ]);
  });

  it('resolves a differently written scope ID to the same row', async () => {
    const h = harness();
    await h.secured.access.at(vault(VAULT)).grant({ principal: alice, role: vaults.$access.roles.keeper });
    const report = await h.secured.access.inspect({
      principal: alice,
      resource: vaults,
      scope: vault(VAULT.toUpperCase())
    });
    expect(report.permissions['read']?.allowed).toBe(true);
    expect(report.roles.map(role => role.inherited)).toEqual([false]);
  });

  it('lists each principal with effective permissions at a scope', async () => {
    const h = harness();
    await h.secured.access.at(organisation('acme')).grant({ principal: alice, role: orgAdmin });
    await h.secured.access.at(project('apollo')).grant({ principal: bob, role: tasks.$access.roles.viewer });
    await h.secured.access.at(project('zeus')).grant({ principal: carol, role: tasks.$access.roles.owner });
    const rows = await h.secured.access.inspectQuery({ resource: tasks, scope: project('apollo') });
    expect(rows.map(row => [row.principalId, row.permissions]).sort()).toEqual([
      ['alice', ['read', 'remove', 'write']],
      ['bob', ['read']]
    ]);
  });
});
