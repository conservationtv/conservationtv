import { connect, drizzle, type Connection, type PostgresDatabase } from 'drizzle-orm/postgres';
import { ApiFailure } from '../errors.ts';
import { traceQueries } from '../tracing/queries.ts';
import { traced, type Tracer } from '../tracing/trace.ts';
import { relations } from './relations.ts';

export type Database = PostgresDatabase<typeof relations>;

export interface DatabaseConnection {
  database(): Promise<Database>;
  close(): Promise<void>;
}

/** Which Postgres role a connection is for: the owning role, or the application role row-level security applies to. */
export type DatabaseRole = 'admin' | 'app';

/**
 * One connection per request and role, as Hyperdrive pools connections on the other side. Drizzle's Postgres driver
 * dials it over `cloudflare:sockets` in the Worker. The connection opens lazily, in a span of its own in the request's
 * trace, and each query on it has a span too (src/tracing/queries.ts). The caller closes it once the response is
 * complete.
 */
export function connectLazily(connectionString: string, role: DatabaseRole, tracer: Tracer): DatabaseConnection {
  let pending: Promise<Connection> | undefined = undefined;
  const plugins = [traceQueries(tracer, { 'studio.database.role': role })];
  const open = () =>
    traced('database.connect', { 'studio.database.role': role }, async () => {
      try {
        return await connect({ url: connectionString, plugins });
      } catch (error) {
        throw new ApiFailure('database_unavailable', { cause: error });
      }
    });
  return {
    async database() {
      if (pending == null) pending = open();
      return drizzle({ client: await pending, relations });
    },
    async close() {
      if (!pending) return;
      const client = await pending.catch(() => undefined);
      await client?.end();
    }
  };
}
