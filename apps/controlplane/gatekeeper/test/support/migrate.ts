import { createPool, drizzle } from 'drizzle-orm/postgres';
import { migrate } from 'drizzle-orm/postgres/migrator';
import { fileURLToPath } from 'node:url';
import { LOCAL_DATABASE_URL } from '../../src/db/local.ts';

/** Bring the test database up to the committed migrations before any test file runs. */
export default async function setup(): Promise<void> {
  const pool = createPool(process.env.DATABASE_URL ?? LOCAL_DATABASE_URL);
  try {
    await migrate(drizzle({ client: pool }), {
      migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url))
    });
  } finally {
    await pool.end();
  }
}
