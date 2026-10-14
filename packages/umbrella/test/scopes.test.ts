import { describe, expect, it } from 'vitest';
import { user } from '../src/index.js';
import { assertHolds, noGrantsNoRows, organisationGrantConfined, projectGrantConfined } from './support/guarantees.js';
import { useHarness } from './support/harness.js';
import { ids, read } from './support/queries.js';
import { notes, organisation, project, projects, tasks, transfers } from './support/schema.js';

const alice = user('alice');

describe('scope hierarchy', () => {
  const harness = useHarness();

  it(noGrantsNoRows.name, () => assertHolds(noGrantsNoRows, harness()));

  it(projectGrantConfined.name, () => assertHolds(projectGrantConfined, harness()));

  it(organisationGrantConfined.name, () => assertHolds(organisationGrantConfined, harness()));

  it('extends a global grant to every row', async () => {
    const h = harness();
    await h.secured.access.root().grant({ principal: alice, role: tasks.$access.roles.viewer });
    expect(ids(await read(h, alice, tasks))).toEqual(['apollo-1', 'gemini-1', 'zeus-1']);
  });

  it('covers rows created after an organisation grant', async () => {
    const h = harness();
    await h.secured.access.at(organisation('acme')).grant({ principal: alice, role: tasks.$access.roles.viewer });
    await h.raw.insert(projects).values({ id: 'hermes', organisationId: 'acme', name: 'Hermes' });
    await h.raw.insert(tasks).values({ id: 'hermes-1', projectId: 'hermes', title: 'Deliver' });
    expect(ids(await read(h, alice, tasks))).toContain('hermes-1');
  });

  it('does not let a grant on a child scope reach its parent', async () => {
    const h = harness();
    await h.secured.access.at(project('apollo')).grant({ principal: alice, role: tasks.$access.roles.owner });
    expect(await read(h, alice, notes)).toEqual([]);
  });

  it('grants a role only on the table that declares it', async () => {
    const h = harness();
    await h.secured.access.at(organisation('acme')).grant({ principal: alice, role: tasks.$access.roles.owner });
    expect(await read(h, alice, projects)).toEqual([]);
  });

  it('accepts a grant through any of several bindings', async () => {
    const h = harness();
    await h.secured.access.at(project('gemini')).grant({ principal: alice, role: transfers.$access.roles.viewer });
    expect(ids(await read(h, alice, transfers))).toEqual(['apollo-to-gemini']);
  });

  it('accumulates grants additively', async () => {
    const h = harness();
    await h.secured.access.at(project('apollo')).grant({ principal: alice, role: tasks.$access.roles.viewer });
    await h.secured.access.at(project('gemini')).grant({ principal: alice, role: tasks.$access.roles.viewer });
    expect(ids(await read(h, alice, tasks))).toEqual(['apollo-1', 'gemini-1']);
  });

  it("does not share one principal's grants with another", async () => {
    const h = harness();
    await h.secured.access.root().grant({ principal: alice, role: tasks.$access.roles.viewer });
    expect(await read(h, user('bob'), tasks)).toEqual([]);
  });
});
