import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { ManifestSchema } from './manifest.ts';

/** What a store knows about one install. Its files live in the store's directory; this is everything else. */
export const InstallRecordSchema = z.object({
  name: z.string(),
  /** The install's folder: its version and the start of its checksum. */
  id: z.string(),
  /** The manifest it was installed from. */
  manifest: ManifestSchema,
  /** The executable, relative to the install's folder. */
  path: z.string(),
  /** When it was installed, as an ISO 8601 timestamp. */
  installedAt: z.string()
});
export type InstallRecord = z.output<typeof InstallRecordSchema>;

/**
 * Where a store keeps its records, as converge keeps its spec: `restore` brings them back when the store is first
 * used, and `sink` saves all of them after every change. A store only treats an install as installed once `sink` has
 * saved its record, so a record that's saved always has its files in place.
 */
export interface Persistence {
  /** The records as last saved. Parsed by the store, which refuses to start on records that don't parse. */
  restore(): Promise<InstallRecord[]>;
  /** Saves every record. If it throws, the change it was saving doesn't happen. */
  sink(records: InstallRecord[]): Promise<void>;
}

/**
 * Records in a JSON file, which is how a store keeps them by default. Each save writes a new file and renames it
 * over the old one, so a save interrupted at any point leaves the previous records whole.
 */
export function jsonFile(path: string): Persistence {
  return {
    async restore() {
      const text = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '[]';
        throw error;
      });
      return InstallRecordSchema.array().parse(JSON.parse(text));
    },
    async sink(records) {
      await mkdir(dirname(path), { recursive: true });
      const written = `${path}.${randomUUID()}`;
      await writeFile(written, JSON.stringify(records, null, 2));
      await rename(written, path);
    }
  };
}

/**
 * Records kept only in memory, starting from `records`. Installs are forgotten when the process exits, and their
 * files are cleared by the next store's prune.
 */
export function inMemory(records: InstallRecord[] = []): Persistence {
  let saved = records;
  return {
    async restore() {
      return saved;
    },
    async sink(next) {
      saved = next;
    }
  };
}
