import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { LOCAL_DATABASE_URL } from '../../src/db/local.ts';

/** Bring the test database up to the committed migrations before any test file runs. */
export default async function setup(): Promise<void> {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? LOCAL_DATABASE_URL });
  try {
    await migrate(drizzle({ client: pool }), { migrationsFolder: new URL('../../drizzle', import.meta.url).pathname });
  } finally {
    await pool.end();
  }
}
