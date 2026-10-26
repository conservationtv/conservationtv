import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '@conservationtv/store';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { migrate } from 'drizzle-orm/node-sqlite/migrator';

// The agent's database: one SQLite file in its directory, beside what its runtimes install and run, through Node's own
// `node:sqlite`. Opened once by the host, which also hands it to the log sink, and closed after the agent stops.

/** The database file, in the agent's directory. */
const DATABASE_FILE = 'agent.sqlite';

/** Where the agent's database is, and where the migrations it is brought up to date with are. */
export interface DatabaseOptions {
  /** The agent's directory: the database is a file in it. */
  directory: string;
  /** The migrations drizzle-kit generated (`apps/agent/core/drizzle`), which ship beside the agent. */
  migrations: string;
}

/**
 * Open the agent's database, and apply the migrations it has not had. WAL with `synchronous = NORMAL` makes each write
 * one append rather than a sync per transaction: a crash may lose the last few, which is fine for samples and logs, and
 * spares an SD card.
 */
export function openDatabase(options: DatabaseOptions) {
  mkdirSync(options.directory, { recursive: true });
  const client = new DatabaseSync(join(options.directory, DATABASE_FILE));
  client.exec('PRAGMA journal_mode = WAL');
  client.exec('PRAGMA synchronous = NORMAL');
  client.exec('PRAGMA busy_timeout = 5000');
  client.exec('PRAGMA foreign_keys = ON');
  const db = drizzle({ client });
  migrate(db, { migrationsFolder: options.migrations });
  return db;
}

export type AgentDatabase = ReturnType<typeof openDatabase>;

/** The agent's database. The agent supplies it on start and with each request; read it with `useDatabase()`. */
export const [withDatabase, useDatabase] = createStore<AgentDatabase>('database');
