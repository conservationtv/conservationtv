import { connect, drizzle, type Connection, type PostgresDatabase } from 'drizzle-orm/postgres';
import { GrantError } from '../errors.ts';

export type Database = PostgresDatabase;

export interface DatabaseConnection {
  database(): Promise<Database>;
  close(): Promise<void>;
}

/**
 * One connection per request, as Hyperdrive pools connections on the other side. Drizzle's Postgres driver dials it
 * over `cloudflare:sockets` in the Worker. The connection opens lazily and is closed by the caller once the response
 * is complete.
 */
export function connectLazily(connectionString: string): DatabaseConnection {
  let pending: Promise<Connection> | undefined = undefined;
  const open = async () => {
    try {
      return await connect(connectionString);
    } catch (error) {
      throw new GrantError('relay_unavailable', { cause: error });
    }
  };
  return {
    async database() {
      if (pending == null) pending = open();
      return drizzle({ client: await pending });
    },
    async close() {
      if (!pending) return;
      const client = await pending.catch(() => undefined);
      await client?.end();
    }
  };
}
