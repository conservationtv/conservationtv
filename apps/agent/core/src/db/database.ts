import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';

// The agent's SQLite database, through Node's own driver: nothing native to ship beside the runner's bundle. One
// handle for the process, opened before converge starts, because converge restores its spec from it, and closed once
// converge has stopped. Runtimes are handed it; nothing else opens the file.

/** The agent's database. */
export type Database = ReturnType<typeof openDatabase>;

/**
 * The migrations drizzle-kit generated, beside this package's source. A host that bundles the agent has no source
 * beside it, so it ships the folder and names it instead.
 */
const MIGRATIONS = new URL('../../drizzle', import.meta.url);
export const DEFAULT_MIGRATIONS_FOLDER = fileURLToPath(MIGRATIONS);

/**
 * Opens the database at `path`, creating it and its directory if need be, and applies the migrations in
 * `migrationsFolder` it has not had. Write-ahead logging lets a reader such as a backup tail the database while the
 * agent writes it.
 */
export function openDatabase(path: string, migrationsFolder: string) {
  mkdirSync(dirname(path), { recursive: true });
  const client = new DatabaseSync(path);
  try {
    client.exec('PRAGMA journal_mode = WAL');
    client.exec('PRAGMA synchronous = NORMAL');
    client.exec('PRAGMA busy_timeout = 5000');
    client.exec('PRAGMA foreign_keys = ON');
    const database = drizzle({ client });
    migrate(database, { migrationsFolder });
    return database;
  } catch (error) {
    client.close();
    throw error;
  }
}

/** Closes the database. Safe when it is already closed. */
export function closeDatabase(database: Database): void {
  const client = database.$client;
  if (client.isOpen) client.close();
}
