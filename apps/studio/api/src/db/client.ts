import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { ApiFailure } from '../errors.ts';
import { relations } from './relations.ts';

export type Database = NodePgDatabase<typeof relations>;

export interface DatabaseConnection {
  database(): Promise<Database>;
  close(): Promise<void>;
}

/**
 * One client per request and role, as Hyperdrive pools connections on the other side. The connection opens lazily and
 * is closed by the caller once the response is complete.
 */
export function connectLazily(connectionString: string): DatabaseConnection {
  let pending: Promise<pg.Client> | undefined = undefined;
  const connect = async () => {
    const client = new pg.Client({ connectionString });
    try {
      await client.connect();
    } catch (error) {
      throw new ApiFailure('database_unavailable', { cause: error });
    }
    return client;
  };
  return {
    async database() {
      if (pending == null) pending = connect();
      return drizzle({ client: await pending, relations });
    },
    async close() {
      if (!pending) return;
      const client = await pending.catch(() => undefined);
      await client?.end();
    }
  };
}
