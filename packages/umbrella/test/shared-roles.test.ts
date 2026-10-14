import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { user } from '../src/index.js';
import { useHarness } from './support/harness.js';
import { attempt, ids, read, remove } from './support/queries.js';
import {
  auditor,
  devices,
  notes,
  orgAdmin,
  organisation,
  organisations,
  projects,
  tasks,
  transfers,
  unused
} from './support/schema.js';

const alice = user('alice');

describe('shared roles', () => {
  const harness = useHarness();

  it('reach every table that includes them, within the granted scope', async () => {
    const h = harness();
    await h.secured.access.at(organisation('acme')).grant({ principal: alice, role: orgAdmin });
    expect(ids(await read(h, alice, organisations))).toEqual(['acme']);
    expect(ids(await read(h, alice, projects))).toEqual(['apollo', 'zeus']);
    expect(ids(await read(h, alice, tasks))).toEqual(['apollo-1', 'zeus-1']);
    expect(ids(await read(h, alice, devices))).toEqual([1]);
  });

  it('do not reach tables that do not include them', async () => {
    const h = harness();
    await h.secured.access.at(organisation('acme')).grant({ principal: alice, role: orgAdmin });
    expect(await read(h, alice, notes)).toEqual([]);
    expect(await read(h, alice, transfers)).toEqual([]);
  });

  it("carry the included table role's full permissions", async () => {
    const h = harness();
    await h.secured.access.at(organisation('acme')).grant({ principal: alice, role: orgAdmin });
    expect(ids(await remove(h, alice, tasks, eq(tasks.id, 'zeus-1')))).toEqual(['zeus-1']);
  });

  it('carry only the permissions of the table role that includes them', async () => {
    const h = harness();
    await h.secured.access.root().grant({ principal: alice, role: auditor });
    expect(ids(await read(h, alice, tasks))).toEqual(['apollo-1', 'gemini-1', 'zeus-1']);
    expect(await attempt(remove(h, alice, tasks, eq(tasks.id, 'zeus-1')))).toEqual([]);
    expect(await read(h, alice, projects)).toEqual([]);
  });

  it('grant nothing when no table includes them', async () => {
    const h = harness();
    await h.secured.access.root().grant({ principal: alice, role: unused });
    for (const table of [organisations, projects, tasks, devices, notes, transfers])
      expect(await read(h, alice, table)).toEqual([]);
  });

  it('are revoked independently of direct table-role grants', async () => {
    const h = harness();
    const acme = h.secured.access.at(organisation('acme'));
    await acme.grant({ principal: alice, role: orgAdmin });
    await acme.grant({ principal: alice, role: tasks.$access.roles.viewer });
    expect(await acme.revoke({ principal: alice, role: orgAdmin })).toBe(1);
    expect(ids(await read(h, alice, tasks))).toEqual(['apollo-1', 'zeus-1']);
    expect(await attempt(remove(h, alice, tasks, eq(tasks.id, 'zeus-1')))).toEqual([]);
    expect(await read(h, alice, projects)).toEqual([]);
  });
});
