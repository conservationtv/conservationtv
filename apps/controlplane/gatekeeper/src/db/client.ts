import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { GrantError } from '../errors.ts';
import * as schema from './schema.ts';

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseConnection {
  database(): Promise<Database>;
  close(): Promise<void>;
}

/**
 * One client per request, as Hyperdrive pools connections on the other side. The connection opens lazily and is closed
 * by the caller once the response is complete.
 */
export function connectLazily(connectionString: string): DatabaseConnection {
  let pending: Promise<pg.Client> | undefined = undefined;
  const connect = async () => {
    const client = new pg.Client({ connectionString });
    try {
      await client.connect();
    } catch (error) {
      throw new GrantError('relay_unavailable', { cause: error });
    }
    return client;
  };
  return {
    async database() {
      if (pending == null) pending = connect();
      return drizzle(await pending, { schema });
    },
    async close() {
      if (!pending) return;
      const client = await pending.catch(() => undefined);
      await client?.end();
    }
  };
}
