import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createPool, drizzle } from 'drizzle-orm/postgres';
import { migrate } from 'drizzle-orm/postgres/migrator';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';

// The test database: a Postgres container of the image the compose file and production's PlanetScale match, started
// once for the run and migrated to the committed migrations, so the tests need Docker and nothing already running.
// DATABASE_URL points them at a database of your own instead, such as `pnpm db:up`'s.

declare module 'vitest' {
  export interface ProvidedContext {
    /** The migrated test database; tests read it with `inject('databaseUrl')`. */
    databaseUrl: string;
  }
}

/**
 * Points Testcontainers at the Docker the `docker` CLI uses. Testcontainers reads DOCKER_HOST or the default socket,
 * not the CLI's current context, so with OrbStack, Colima or a remote context it would find no Docker at all.
 */
export function useDockerContext(): void {
  if (process.env.DOCKER_HOST) return;
  try {
    const host = execFileSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], {
      encoding: 'utf8'
    }).trim();
    if (host) process.env.DOCKER_HOST = host;
  } catch {
    // No docker CLI: Testcontainers looks for Docker itself, and says so when it can't find any.
  }
}

/** Starts the container (unless DATABASE_URL names a database), migrates it, and stops it after the run. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  useDockerContext();
  let container: StartedPostgreSqlContainer | null = null;
  const url =
    process.env.DATABASE_URL ??
    (container = await new PostgreSqlContainer('postgres:18-alpine').start()).getConnectionUri();
  const pool = createPool(url);
  try {
    await migrate(drizzle({ client: pool }), {
      migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url))
    });
  } finally {
    await pool.end();
  }
  project.provide('databaseUrl', url);
  return async () => {
    await container?.stop();
  };
}
