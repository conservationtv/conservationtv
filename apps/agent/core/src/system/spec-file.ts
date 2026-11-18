import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Controllers, SystemSpec } from '@conservationtv/converge';
import { getLogger } from '@logtape/logtape';
import { z } from 'zod';

// The system's spec, kept in a file in the agent's directory so a restart picks up where the agent left off rather
// than starting from nothing until the studio answers (system.ts). Converge saves each spec it accepts here before
// applying it (`sink`), and starts from what was saved (`restore`).
//
// What is saved is the spec as the runtimes take it, which carries credentials: the gateway's TLS key, and the
// short-lived tokens in the publishers', previews' and relay stats' URLs. So the file is the agent's alone (0600),
// as the TLS files are (gateway/streams/tls.ts). A restored token may have expired: the studio configuration is asked
// for as soon as the agent starts, and renews it.
//
// A saved key that no longer parses, as after an upgrade changes its spec, is left out and logged, rather than failing
// the start: its runtime is finalised until the studio configuration gives it again.

const logger = getLogger(['agent', 'spec']);

/** The saved file, as far as it is read before each key's own schema: a spec per key. */
const SavedSchema = z.record(z.string(), z.unknown());
type Saved = z.output<typeof SavedSchema>;

/** Where the system's spec is saved, and how it is read back. */
export interface SpecFile<R extends Controllers> {
  /** The spec last saved, each key that still parses; undefined when nothing was saved, or it can't be read. */
  restore(): Promise<SystemSpec<R> | undefined>;
  /**
   * Saves `spec`, replacing what was saved whole, so a save interrupted at any point leaves the previous one. A save
   * that fails is logged rather than thrown: the agent keeps following the studio, and restores an older spec next
   * time, which the studio configuration then corrects.
   */
  sink(spec: SystemSpec<R>): Promise<void>;
}

/** The system's spec, kept at `path`, each key read back by its controller's schema. */
export function specFile<R extends Controllers>(path: string, controllers: R): SpecFile<R> {
  return {
    restore: () => restore(path, controllers),
    sink: spec => sink(path, spec)
  };
}

async function restore<R extends Controllers>(path: string, controllers: R): Promise<SystemSpec<R> | undefined> {
  const saved = await read(path);
  if (saved === undefined) return undefined;
  const spec: Saved = {};
  for (const [key, value] of Object.entries(saved)) {
    // Each key the system still has, if it still parses; anything else is left out, and said so.
    const controller = Object.hasOwn(controllers, key) ? controllers[key] : undefined;
    const parsed = controller?.spec.safeParse(value);
    if (parsed?.success) spec[key] = parsed.data;
    else logger.warn('Left {key} out of the saved spec: it no longer parses', { key, path });
  }
  // SAFETY: `spec` holds only keys of `controllers`, each parsed by that controller's own schema.
  return spec as SystemSpec<R>;
}

/** The saved file's specs by key: undefined when there is none, or it can't be read or isn't JSON of that shape. */
async function read(path: string): Promise<Saved | undefined> {
  // No file is a first start; anything else is a file the agent can't use, so it starts as though it were one.
  const text = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT')
      logger.error('Starting without the saved spec: {path} could not be read: {error}', { path, error });
    return undefined;
  });
  if (text === undefined) return undefined;
  try {
    return SavedSchema.parse(JSON.parse(text));
  } catch (error) {
    logger.error('Starting without the saved spec: {path} is not one: {error}', { path, error });
    return undefined;
  }
}

async function sink<Spec>(path: string, spec: Spec): Promise<void> {
  const written = `${path}.${randomUUID()}`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(written, JSON.stringify(spec, null, 2), { mode: 0o600 });
    await rename(written, path);
  } catch (error) {
    logger.error('Saving the spec to {path} failed: {error}', { path, error });
    await rm(written, { force: true }).catch(() => undefined);
  }
}
