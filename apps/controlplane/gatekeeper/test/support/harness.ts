import { readBuildOutput } from '@cloudflare/build-output-utils';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, WorkerOptionsSchema } from 'miniflare';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { exportJWK, generateKeyPair } from 'jose';
import pg from 'pg';
import type { Json } from '@conservationtv/versioned-api/server';
import type { Database } from '../../src/db/client.ts';
import { LOCAL_DATABASE_URL } from '../../src/db/local.ts';

export const CONSUMER_TOKEN = 'consumer-test-token';
export const RELAY_TOKEN = 'relay-test-token';
export const MOQ_RELAY_TOKEN = 'e'.repeat(64);
export const MOQ_CLUSTER_TOKEN = 'c'.repeat(64);
export const MOQ_KEY_ID = 'controlplane-moq-test';

export interface TestDatabase {
  database: Database;
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** A pooled connection to `connectionString`, with the state tests reset between cases. */
export function connectTestDatabase(connectionString = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL): TestDatabase {
  const pool = new pg.Pool({ connectionString });
  const database: Database = drizzle({ client: pool });
  return {
    database,
    reset: async () => {
      await database.execute(sql`truncate iroh_leases, grants`);
    },
    close: () => pool.end()
  };
}

// Test-owned credentials supplied as secrets, with public-key verification independent of Worker internals.
const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
const signingKeys = JSON.stringify({
  active_kid: MOQ_KEY_ID,
  keys: [{ ...(await exportJWK(privateKey)), kid: MOQ_KEY_ID, alg: 'ES256', use: 'sig' }]
});

const { workers } = await readBuildOutput(fileURLToPath(new URL('../../', import.meta.url)));
const { config, bundleDir } = workers.default;
if (!bundleDir || !config.manifest) throw new Error('Run pnpm build before the Worker tests');
const { manifest, ...settings } = config;
const modules = Object.fromEntries(
  await Promise.all(
    Object.entries(manifest.modules).map(async ([name, module]) => [
      name,
      { type: module.type, contents: await readFile(join(bundleDir, name)) }
    ])
  )
);
const built = { ...settings, manifest: { mainModule: manifest.mainModule, modules } };

export interface TestWorker {
  verificationKey: Awaited<ReturnType<typeof generateKeyPair>>['publicKey'];
  request(path: string, init?: RequestInit): Promise<Response>;
  /** Exchange `grant` as the consumer, or with another bearer token (`undefined` sends none). */
  exchange(grant: Json, token?: string | undefined): Promise<Response>;
  /** Restart with current bindings, or replace overrides ({} restores test defaults). */
  restart(bindings?: WorkerOptions['bindings']): Promise<void>;
  close(): Promise<void>;
}

export interface WorkerOptions {
  /** Undefined retains the built deployment's value; an explicit string replaces it. */
  bindings?: Record<string, string | undefined>;
  connectionString?: string;
}

/** Boot the unmodified production bundle. Only deployment inputs are controlled. */
export async function startWorker(options: WorkerOptions = {}): Promise<TestWorker> {
  // Apply deployment overrides to the build, connect local Postgres, and clean up if runtime startup fails.
  const start = async (overrides: WorkerOptions['bindings']) => {
    const env = { ...built.env };
    const hyperdrive = env.HYPERDRIVE;
    if (hyperdrive?.type !== 'hyperdrive') throw new Error('Build must declare the HYPERDRIVE binding');
    env.HYPERDRIVE = {
      ...hyperdrive,
      dev: { connectionString: options.connectionString ?? process.env.DATABASE_URL ?? LOCAL_DATABASE_URL }
    };
    const bindings = {
      CONSUMER_TOKEN,
      MOQ_SIGNING_KEYS: signingKeys,
      IROH_RELAY_TOKEN: RELAY_TOKEN,
      MOQ_RELAY_TOKEN,
      MOQ_CLUSTER_TOKEN,
      ...overrides
    };
    for (const [name, value] of Object.entries(bindings)) {
      if (value !== undefined) env[name] = { type: 'text', value };
    }
    const runtime = new Miniflare({
      cf: false,
      telemetry: { enabled: false },
      workers: [WorkerOptionsSchema.parse({ config: { ...built, env } })]
    });
    try {
      await runtime.ready;
      return runtime;
    } catch (error) {
      await runtime.dispose();
      throw error;
    }
  };
  let bindings = options.bindings;
  let runtime = await start(bindings);
  const request = async (path: string, init?: RequestInit): Promise<Response> =>
    fetch(new URL(path, await runtime.ready), { redirect: 'manual', ...init });
  return {
    verificationKey: publicKey,
    request,
    exchange: (grant, ...token) => {
      const bearer = token.length ? token[0] : CONSUMER_TOKEN;
      const headers = new Headers({ 'content-type': 'application/json' });
      if (bearer !== undefined) headers.set('authorization', `Bearer ${bearer}`);
      return request('/grants/exchange', { method: 'POST', headers, body: JSON.stringify(grant) });
    },
    async restart(overrides = bindings) {
      await runtime.dispose();
      bindings = overrides;
      runtime = await start(bindings);
    },
    close: () => runtime.dispose()
  };
}
