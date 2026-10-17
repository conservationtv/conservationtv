import { bearer, Client, type Grant } from '@conservationtv/controlplane-sdk';
import {
  connectTestDatabase,
  CONSUMER_TOKEN,
  startWorker,
  exampleGrant,
  MIGRATIONS_FOLDER,
  type TestDatabase
} from '@conservationtv/gatekeeper/testing';
import { serve, type ServerType } from '@hono/node-server';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

/** How relay containers reach services on the host: Docker Desktop resolves it natively, Linux via `host-gateway`. */
export const DOCKER_HOST = 'host.docker.internal';
export const DOCKER_HOST_ENTRY = { host: DOCKER_HOST, ipAddress: 'host-gateway' };

export type ExampleGrant = ReturnType<typeof exampleGrant>;

/** One relay callout as the gatekeeper saw and answered it. */
export interface RelayCallout {
  path: string;
  status: number;
  headers: Headers;
  body: string;
}

export interface GatekeeperServer {
  /** The gatekeeper as relay containers address it. */
  containerUrl: string;
  database: TestDatabase;
  callouts: RelayCallout[];
  /** Exchange `grant` as the consumer, through the SDK. */
  exchange(grant: ExampleGrant): Promise<Grant>;
  /** Clear state and start a fresh Worker isolate. */
  reset(): Promise<void>;
  stop(): Promise<void>;
}

function listen(fetch: (request: Request) => Promise<Response>): Promise<ServerType> {
  return new Promise(resolve => {
    const server = serve({ fetch, hostname: '0.0.0.0', port: 0 }, () => resolve(server));
  });
}

/**
 * Forward relay traffic to the production Worker bundle running in workerd, backed by container Postgres.
 * This host listener records callouts; all request handling runs through the Worker's real entrypoint.
 */
export async function startGatekeeper(): Promise<GatekeeperServer> {
  const postgres = await new PostgreSqlContainer('postgres:18-alpine').start();
  const database = connectTestDatabase(postgres.getConnectionUri());
  await migrate(database.database, { migrationsFolder: MIGRATIONS_FOLDER });
  const callouts: RelayCallout[] = [];
  const worker = await startWorker({ connectionString: postgres.getConnectionUri() });

  const server = await listen(async request => {
    const { pathname, search } = new URL(request.url);
    const body = await request.text();
    const response = await worker.request(pathname + search, {
      method: request.method,
      // Node fetch decompresses responses; request plain bytes so forwarding their headers stays correct.
      headers: { ...Object.fromEntries(request.headers), 'accept-encoding': 'identity' },
      body: request.body ? body : undefined
    });
    if (pathname.startsWith('/relays/')) {
      callouts.push({ path: pathname, status: response.status, headers: request.headers, body });
    }
    return response;
  });

  const info = server.address();
  // eslint-disable-next-line anti-slop/no-runtime-typeof -- Node returns an address object, a Unix socket path, or null.
  if (!info || typeof info === 'string') throw new Error('Expecting a AddressInfo object rather than a string.');
  const port = info.port;
  const client = new Client({ baseUrl: `http://127.0.0.1:${port}`, auth: bearer(CONSUMER_TOKEN) });
  await client.handshake();

  return {
    containerUrl: `http://${DOCKER_HOST}:${port}`,
    database,
    callouts,
    async exchange(grant) {
      const result = await client.grants.exchange.v1(grant);
      if (result instanceof Error) throw result;
      return result;
    },
    async reset() {
      await worker.restart();
      await database.reset();
      callouts.length = 0;
    },
    async stop() {
      await new Promise(resolve => server.close(resolve));
      await worker.close();
      await database.close();
      await postgres.stop();
    }
  };
}
