import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { roleAssignments, user } from '../src/index.js';
import { assertHolds, misplacedGrantInert, revocationComplete } from './support/guarantees.js';
import { useHarness } from './support/harness.js';
import { ids, read } from './support/queries.js';
import { VAULT, orgAdmin, organisation, project, projects, tasks, vault, vaults } from './support/schema.js';

const alice = user('alice');
const assignments = (h: ReturnType<ReturnType<typeof useHarness>>) => h.raw.select().from(roleAssignments);

describe('granting', () => {
  const harness = useHarness();

  it('rejects a grant at a scope row that does not exist', async () => {
    const h = harness();
    await expect(
      h.secured.access.at(project('missing')).grant({ principal: alice, role: tasks.$access.roles.viewer })
    ).rejects.toThrow('Scope does not exist');
    expect(await assignments(h)).toEqual([]);
  });

  it('rejects a role at a scope level it is not assignable at', async () => {
    const h = harness();
    const acme = h.secured.access.at(organisation('acme'));
    // @ts-expect-error editor is assignable only at project scope
    await expect(acme.grant({ principal: alice, role: tasks.$access.roles.editor })).rejects.toThrow(TypeError);
    // @ts-expect-error orgAdmin is assignable only at organisation scope
    await expect(h.secured.access.root().grant({ principal: alice, role: orgAdmin })).rejects.toThrow(TypeError);
    expect(await assignments(h)).toEqual([]);
  });

  it('rejects a window that ends before it starts', async () => {
    const h = harness();
    const at = new Date('2030-01-01T00:00:00Z');
    await expect(
      h.secured.access
        .at(project('apollo'))
        .grant({ principal: alice, role: tasks.$access.roles.viewer, startsAt: at, expiresAt: at })
    ).rejects.toThrow(TypeError);
  });

  it('returns the existing assignment for an identical grant', async () => {
    const h = harness();
    const apollo = h.secured.access.at(project('apollo'));
    const first = await apollo.grant({ principal: alice, role: tasks.$access.roles.viewer });
    const second = await apollo.grant({ principal: alice, role: tasks.$access.roles.viewer });
    expect(second.id).toBe(first.id);
    expect(await assignments(h)).toHaveLength(1);
  });

  it('keeps grants with different windows separate', async () => {
    const h = harness();
    const apollo = h.secured.access.at(project('apollo'));
    await apollo.grant({ principal: alice, role: tasks.$access.roles.viewer });
    await apollo.grant({ principal: alice, role: tasks.$access.roles.viewer, expiresAt: new Date('2030-01-01') });
    expect(await assignments(h)).toHaveLength(2);
  });
});

describe('revoking', () => {
  const harness = useHarness();

  it('by scope removes matching grants there and nowhere else', async () => {
    const h = harness();
    for (const id of ['apollo', 'zeus'])
      await h.secured.access.at(project(id)).grant({ principal: alice, role: tasks.$access.roles.viewer });
    expect(
      await h.secured.access.at(project('apollo')).revoke({ principal: alice, role: tasks.$access.roles.viewer })
    ).toBe(1);
    expect(ids(await read(h, alice, tasks))).toEqual(['zeus-1']);
  });

  it('by scope distinguishes levels whose rows share an ID', async () => {
    const h = harness();
    await h.raw.insert(projects).values({ id: 'acme', organisationId: 'acme', name: 'Acme project' });
    await h.raw.insert(tasks).values({ id: 'acme-1', projectId: 'acme', title: 'Ship' });
    await h.secured.access.at(organisation('acme')).grant({ principal: alice, role: tasks.$access.roles.viewer });
    await h.secured.access.at(project('acme')).grant({ principal: alice, role: tasks.$access.roles.viewer });
    await h.secured.access.at(project('acme')).revoke({ principal: alice, role: tasks.$access.roles.viewer });
    expect(ids(await read(h, alice, tasks))).toEqual(['acme-1', 'apollo-1', 'zeus-1']);
    expect((await assignments(h)).map(row => row.scopeName)).toEqual(['organisation']);
  });

  it('by scope leaves other principals and roles in place', async () => {
    const h = harness();
    const apollo = h.secured.access.at(project('apollo'));
    await apollo.grant({ principal: alice, role: tasks.$access.roles.viewer });
    await apollo.grant({ principal: alice, role: tasks.$access.roles.editor });
    await apollo.grant({ principal: user('bob'), role: tasks.$access.roles.viewer });
    await apollo.revoke({ principal: alice, role: tasks.$access.roles.viewer });
    const remaining = await assignments(h);
    expect(remaining.map(row => [row.principalId, row.role]).sort()).toEqual([
      ['alice', 'editor'],
      ['bob', 'viewer']
    ]);
  });

  it("without a role removes all of the principal's grants at the scope and nowhere else", async () => {
    const h = harness();
    const apollo = h.secured.access.at(project('apollo'));
    await apollo.grant({ principal: alice, role: tasks.$access.roles.viewer });
    await apollo.grant({ principal: alice, role: tasks.$access.roles.editor });
    await apollo.grant({ principal: user('bob'), role: tasks.$access.roles.viewer });
    await h.secured.access.at(project('zeus')).grant({ principal: alice, role: tasks.$access.roles.viewer });
    expect(await apollo.revoke({ principal: alice })).toBe(2);
    const remaining = await assignments(h);
    expect(remaining.map(row => [row.principalId, row.scopeId]).sort()).toEqual([
      ['alice', 'zeus'],
      ['bob', 'apollo']
    ]);
    expect(ids(await read(h, alice, tasks))).toEqual(['zeus-1']);
  });

  it("all at a scope removes every principal's grants there and nowhere else", async () => {
    const h = harness();
    await h.raw.insert(projects).values({ id: 'acme', organisationId: 'acme', name: 'Acme project' });
    const acmeProject = h.secured.access.at(project('acme'));
    await acmeProject.grant({ principal: alice, role: tasks.$access.roles.viewer });
    await acmeProject.grant({ principal: user('bob'), role: tasks.$access.roles.editor });
    await h.secured.access.at(organisation('acme')).grant({ principal: alice, role: tasks.$access.roles.viewer });
    await h.secured.access.at(project('apollo')).grant({ principal: user('bob'), role: tasks.$access.roles.viewer });
    expect(await acmeProject.all.revoke()).toBe(2);
    const remaining = await assignments(h);
    expect(remaining.map(row => [row.principalId, row.scopeName, row.scopeId]).sort()).toEqual([
      ['alice', 'organisation', 'acme'],
      ['bob', 'project', 'apollo']
    ]);
  });

  it('still works after the scope row is deleted', async () => {
    const h = harness();
    await h.secured.access.at(vault(VAULT)).grant({ principal: alice, role: vaults.$access.roles.keeper });
    await h.secured.access.at(vault(VAULT)).grant({ principal: user('bob'), role: vaults.$access.roles.keeper });
    await h.raw.delete(vaults).where(eq(vaults.id, VAULT));
    expect(
      await h.secured.access.at(vault(VAULT)).revoke({ principal: alice, role: vaults.$access.roles.keeper })
    ).toBe(1);
    expect(await h.secured.access.at(vault(VAULT)).all.revoke()).toBe(1);
  });
});

describe('listing', () => {
  const harness = useHarness();

  it('includes grants from ancestor scopes only when asked', async () => {
    const h = harness();
    await h.secured.access.root().grant({ principal: alice, role: tasks.$access.roles.viewer });
    await h.secured.access.at(organisation('acme')).grant({ principal: alice, role: orgAdmin });
    await h.secured.access.at(organisation('globex')).grant({ principal: alice, role: orgAdmin });
    await h.secured.access.at(project('apollo')).grant({ principal: alice, role: tasks.$access.roles.editor });
    const apollo = h.secured.access.at(project('apollo'));
    expect((await apollo.list()).map(row => row.role)).toEqual(['editor']);
    const inherited = await apollo.list({ includeInherited: true });
    expect(inherited.map(row => `${row.scopeName}:${row.scopeId}:${row.role}`).sort()).toEqual([
      'global::viewer',
      'organisation:acme:orgAdmin',
      'project:apollo:editor'
    ]);
  });
});

describe('scope IDs in their canonical form', () => {
  const harness = useHarness();
  const upper = VAULT.toUpperCase();

  it('match a grant made with a differently written ID', async () => {
    const h = harness();
    await h.secured.access.at(vault(upper)).grant({ principal: alice, role: vaults.$access.roles.keeper });
    expect(ids(await read(h, alice, vaults))).toEqual([VAULT]);
  });

  it(revocationComplete.name, () => assertHolds(revocationComplete, harness()));

  it(misplacedGrantInert.name, () => assertHolds(misplacedGrantInert, harness()));

  it('let the canonical ID revoke a grant made with a differently written one', async () => {
    const h = harness();
    await h.secured.access.at(vault(upper)).grant({ principal: alice, role: vaults.$access.roles.keeper });
    await h.secured.access.at(vault(VAULT)).revoke({ principal: alice, role: vaults.$access.roles.keeper });
    expect(await read(h, alice, vaults)).toEqual([]);
  });

  it('let a differently written ID revoke the grant', async () => {
    const h = harness();
    await h.secured.access.at(vault(VAULT)).grant({ principal: alice, role: vaults.$access.roles.keeper });
    await h.secured.access.at(vault(upper)).revoke({ principal: alice, role: vaults.$access.roles.keeper });
    expect(await read(h, alice, vaults)).toEqual([]);
  });
});
