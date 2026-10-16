import { readFile } from 'node:fs/promises';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, afterEach, beforeEach } from 'vitest';
import { rlsMigration, withAuthorization } from '../../src/index.js';
import { ddl, sharedRoles, tables } from './schema.js';

/** The application's login role. The admin connection is the owner. */
export const appRole = 'app';

/** One migrated, seeded database per test file; each test runs against its own clone. */
async function buildTemplate(): Promise<PGlite> {
  const pg = new PGlite();
  await pg.exec(await readFile(new URL('../../migrations/0000_authz.sql', import.meta.url), 'utf8'));
  await pg.exec(ddl);
  await pg.exec(rlsMigration(tables));
  await pg.exec(`
    create role ${appRole} login;
    grant select, insert, update, delete on all tables in schema public to ${appRole};
  `);
  return pg;
}
let template: Promise<PGlite> | undefined = undefined;

type QueryArguments = Parameters<PGlite['query']>;
/**
 * PGlite has a single backend session, so the application login is simulated: every application statement and
 * transaction runs under `set local role`. (PGlite does not undo `set local session authorization` at commit.)
 * Unlike a real login this can be undone with SET ROLE NONE, so these tests cover policy guarantees, not
 * escape from the login role.
 */
function loginAs(pg: PGlite, role: string) {
  const enter = `set local role ${role}`;
  return {
    query: async (...args: QueryArguments) =>
      pg.transaction(async tx => {
        await tx.query(enter);
        return tx.query(...args);
      }),
    transaction: async <R>(run: (tx: Transaction) => Promise<R>) =>
      pg.transaction(async tx => {
        await tx.query(enter);
        return run(tx);
      })
  };
}
function connect(pg: PGlite, clock: () => Date) {
  const raw = drizzle({ client: pg });
  // SAFETY: Drizzle's PGlite driver calls only query and transaction, which loginAs forwards with the same shapes.
  const app = drizzle({ client: loginAs(pg, appRole) as never });
  const secured = withAuthorization({ app, admin: raw }, { schema: tables, roles: sharedRoles, clock });
  return { raw, app, secured };
}
export type Connection = ReturnType<typeof connect>;
export interface Harness extends Connection {
  readonly pg: PGlite;
  /** Pins the inspection clock. Enforcement always uses the database's statement time. */
  setNow(now: Date): void;
}

/** Registers a fresh database for every test in the calling file. */
export function useHarness(): () => Harness {
  let current: Harness | undefined = undefined;
  beforeEach(async () => {
    if (template === undefined) template = buildTemplate();
    // SAFETY: Cloning a PGlite instance produces another PGlite instance.
    const pg = (await (await template).clone()) as PGlite;
    let now: Date | undefined = undefined;
    current = { pg, ...connect(pg, () => now ?? new Date()), setNow: value => (now = value) };
  });
  afterEach(async () => {
    await current?.pg.close();
    current = undefined;
  });
  afterAll(async () => {
    await (await template)?.close();
    template = undefined;
  });
  return () => {
    if (!current) throw new Error('The harness is only available inside a test');
    return current;
  };
}
