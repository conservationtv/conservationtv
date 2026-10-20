import { join } from 'node:path';
import { controller, converge, type Mutator, type SystemSpec } from '@conservationtv/converge';
import { createStore } from '@conservationtv/store';
import type { AgentConfiguration } from './config.ts';
import { DEFAULT_MIGRATIONS_FOLDER, closeDatabase, type Database, openDatabase } from './db/database.ts';
import { readSpec, writeSpec } from './db/spec.ts';
import { MachineRuntime, MachineSpecSchema } from './runtimes/machine.ts';
import { MEDIAMTX_MANIFEST, MediamtxRuntime, MediamtxSpecSchema } from './runtimes/mediamtx/index.ts';

function controllers(config: AgentConfiguration) {
  const machine = new MachineRuntime(config);
  const mediamtx = new MediamtxRuntime(config, {
    directory: join(config.directory, 'mediamtx'),
    api: '127.0.0.1:9997',
    metrics: '127.0.0.1:9998'
  });
  return {
    machine: controller({
      spec: MachineSpecSchema,
      status: machine.status$,
      execute: spec => machine.apply(spec),
      finalize: () => machine.teardown(),
      dispose: () => machine.dispose()
    }),
    mediamtx: controller({
      spec: MediamtxSpecSchema,
      status: mediamtx.status$,
      execute: (spec, signal) => mediamtx.execute(spec, signal),
      finalize: () => mediamtx.finalize(),
      dispose: () => mediamtx.dispose()
    })
  };
}

type AgentControllers = ReturnType<typeof controllers>;
type AgentSpec = SystemSpec<AgentControllers>;

/** The spec the host fixes in code and config, until mutators bring each key's spec from elsewhere. */
function hostSpec(config: AgentConfiguration): AgentSpec {
  return {
    machine: { intervalMs: 60_000 },
    mediamtx: { binary: MEDIAMTX_MANIFEST, paths: config.mediamtxPaths ?? [], metricsIntervalMs: 60_000 }
  };
}

/**
 * Applies the host's spec once the system has started. The runtimes resume the spec last saved, and this replaces it
 * with what the host now says, such as a new MediaMTX release or changed paths; one that is unchanged leaves the
 * database untouched.
 */
function hostMutator(config: AgentConfiguration): Mutator<AgentControllers> {
  return changes => {
    const apply = async () => {
      const spec = hostSpec(config);
      try {
        await changes.replace(spec);
      } catch (error) {
        console.error(JSON.stringify({ event: 'host_spec_rejected', error: String(error) }));
      }
    };
    void apply();
    return () => undefined;
  };
}

/**
 * Opens the database, then converges from the spec saved in it, saving each accepted spec back. The first start, with
 * nothing saved, starts from the host's spec, so no key is finalized for being absent. Stopping stops converge, then
 * closes the database.
 */
export async function startSystem(config: AgentConfiguration) {
  const path = config.databasePath ?? join(config.directory, 'agent.db');
  const migrationsFolder = config.migrationsFolder ?? DEFAULT_MIGRATIONS_FOLDER;
  const database = openDatabase(path, migrationsFolder);
  try {
    const convergence = await converge({
      controllers: controllers(config),
      restore: async () => {
        const saved = await readSpec<AgentSpec>(database);
        return saved ?? hostSpec(config);
      },
      sink: spec => writeSpec(database, spec),
      mutators: [hostMutator(config)]
    });
    const stop = async () => {
      try {
        await convergence.stop();
      } finally {
        closeDatabase(database);
      }
    };
    return { ...convergence, database, stop };
  } catch (error) {
    closeDatabase(database);
    throw error;
  }
}

/** The running agent's system. The host supplies it with each request; handlers read it with `useSystem()`. */
export type AgentSystem = Awaited<ReturnType<typeof startSystem>>;
export const [withSystem, useSystem] = createStore<AgentSystem>('system');

export type { Database };
