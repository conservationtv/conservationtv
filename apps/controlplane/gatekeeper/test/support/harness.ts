import { readBuildOutput } from '@cloudflare/build-output-utils';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, type Request as WorkerRequest, Response as WorkerResponse, WorkerOptionsSchema } from 'miniflare';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import pg from 'pg';
import type { Database } from '../../src/db/client.ts';
import { LOCAL_DATABASE_URL } from '../../src/db/local.ts';
import * as schema from '../../src/db/schema.ts';
import { JWKS_URI, registration } from './consumer.ts';

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
  const database: Database = drizzle(pool, { schema });
  return {
    database,
    reset: async () => {
      await database.execute(sql`truncate assertion_replays, iroh_leases, grants, jwks_cache`);
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

export type JwksBehaviour = 'serve' | 'fail' | 'redirect' | 'oversized' | 'private';

/** The consumer's hosted JWKS document, as the control plane's fetcher sees it. */
export class JwksEndpoint {
  keys: JWK[] = [];
  behaviour: JwksBehaviour = 'serve';
  maxAge = 300;
  requests = 0;

  /** Serve the registered URI with the selected response or failure mode. */
  fetch = (request: WorkerRequest): WorkerResponse => {
    if (request.url !== JWKS_URI) return new WorkerResponse('not found', { status: 404 });
    this.requests++;
    const headers = { 'content-type': 'application/jwk-set+json', 'cache-control': `max-age=${this.maxAge}` };
    switch (this.behaviour) {
      case 'fail':
        return new WorkerResponse('unavailable', { status: 503 });
      case 'redirect':
        return new WorkerResponse(null, { status: 302, headers: { location: 'https://elsewhere.example/jwks.json' } });
      case 'oversized':
        return new WorkerResponse(JSON.stringify({ keys: this.keys, padding: 'x'.repeat(70_000) }), { headers });
      case 'private':
        return new WorkerResponse(JSON.stringify({ keys: this.keys.map(key => ({ ...key, d: 'secret' })) }), {
          headers
        });
      default:
        return new WorkerResponse(JSON.stringify({ keys: this.keys }), { headers });
    }
  };
}

export interface TestWorker {
  jwks: JwksEndpoint;
  verificationKey: Awaited<ReturnType<typeof generateKeyPair>>['publicKey'];
  request(path: string, init?: RequestInit): Promise<Response>;
  exchange(grantAssertion: string): Promise<Response>;
  /** Restart with current bindings, or replace overrides ({} restores test defaults). JWKS state is retained. */
  restart(bindings?: WorkerOptions['bindings']): Promise<void>;
  close(): Promise<void>;
}

export interface WorkerOptions {
  /** Undefined retains the built deployment's value; an explicit string replaces it. */
  bindings?: Record<string, string | undefined>;
  connectionString?: string;
}

/** Boot the unmodified production bundle. Only deployment inputs and the external JWKS server are controlled. */
export async function startWorker(options: WorkerOptions = {}): Promise<TestWorker> {
  const jwks = new JwksEndpoint();
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
      CONSUMER_REGISTRATIONS: JSON.stringify([registration()]),
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
      workers: [
        WorkerOptionsSchema.parse({
          config: { ...built, env },
          dev: {
            outboundService: {
              type: 'fetcher',
              handler: jwks.fetch
            }
          }
        })
      ]
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
    jwks,
    verificationKey: publicKey,
    request,
    exchange: grantAssertion =>
      request('/grants/exchange', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grant_assertion: grantAssertion })
      }),
    async restart(overrides = bindings) {
      await runtime.dispose();
      bindings = overrides;
      runtime = await start(bindings);
    },
    close: () => runtime.dispose()
  };
}
