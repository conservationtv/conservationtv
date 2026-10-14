import { describe, expect, it } from 'vitest';
import { user } from '../src/index.js';
import { assertHolds, expiredGrantInert } from './support/guarantees.js';
import { useHarness, type Harness } from './support/harness.js';
import { ids, read } from './support/queries.js';
import { project, tasks } from './support/schema.js';

const alice = user('alice');
const hour = 60 * 60 * 1000;
interface GrantWindow {
  startsAt?: Date;
  expiresAt?: Date;
}
const fromNow = (ms: number) => new Date(Date.now() + ms);

describe('grant time windows', () => {
  const harness = useHarness();
  const grant = (h: Harness, window: GrantWindow = {}) =>
    h.secured.access.at(project('apollo')).grant({ principal: alice, role: tasks.$access.roles.viewer, ...window });

  it('does not apply a grant before it starts', async () => {
    const h = harness();
    await grant(h, { startsAt: fromNow(hour) });
    expect(await read(h, alice, tasks)).toEqual([]);
  });

  it(expiredGrantInert.name, () => assertHolds(expiredGrantInert, harness()));

  it('applies a grant inside its window', async () => {
    const h = harness();
    await grant(h, { startsAt: fromNow(-hour), expiresAt: fromNow(hour) });
    expect(ids(await read(h, alice, tasks))).toEqual(['apollo-1']);
  });

  it('stops applying a grant as soon as it is revoked', async () => {
    const h = harness();
    const assignment = await grant(h);
    expect(ids(await read(h, alice, tasks))).toEqual(['apollo-1']);
    await h.secured.access.revoke(assignment.id);
    expect(await read(h, alice, tasks)).toEqual([]);
  });
});

/**
 * Policies use the database's statement time, which a test cannot pin. Inspection evaluates the same window
 * condition at a chosen instant, so the boundaries are checked there.
 */
describe('grant window boundaries', () => {
  const harness = useHarness();
  const start = new Date('2030-01-01T00:00:00Z');
  const end = new Date('2030-01-02T00:00:00Z');
  const readableAt = async (h: Harness, now: Date) => {
    const report = await h.secured.access.inspect({ principal: alice, resource: tasks, scope: project('apollo'), now });
    return report.permissions['read']?.allowed;
  };

  it('includes the start instant', async () => {
    const h = harness();
    await h.secured.access
      .at(project('apollo'))
      .grant({ principal: alice, role: tasks.$access.roles.viewer, startsAt: start, expiresAt: end });
    expect(await readableAt(h, new Date(start.getTime() - 1))).toBe(false);
    expect(await readableAt(h, start)).toBe(true);
  });

  it('excludes the expiry instant', async () => {
    const h = harness();
    await h.secured.access
      .at(project('apollo'))
      .grant({ principal: alice, role: tasks.$access.roles.viewer, startsAt: start, expiresAt: end });
    expect(await readableAt(h, new Date(end.getTime() - 1))).toBe(true);
    expect(await readableAt(h, end)).toBe(false);
  });
});
