import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Check } from './checks.ts';
import { type Fetch, download } from './download.ts';
import { type Format, type Manifest, ManifestSchema, artifactFor } from './manifest.ts';
import { type Unpack, unpackers } from './unpack.ts';

export interface BinaryStoreOptions {
  /** A directory of the store's own. Each binary gets a folder in it, with each version installed beside the others. */
  directory: string;
  /** Unpackers to use in place of the defaults, by format. */
  unpackers?: Partial<Record<Format, Unpack>>;
  /** Run against each unpacked binary, in order, before it's installed. Any that throws turns the binary away. */
  checks?: Check[];
  /** How downloads are fetched. `globalThis.fetch` by default. */
  fetch?: Fetch;
}

/** A binary installed and ready to run. */
export interface Installed {
  name: string;
  version: string;
  /** Tells installs apart: two downloads claiming the same version but with different checksums are different. */
  id: string;
  /** The executable. */
  path: string;
  /** When it was installed, as an ISO 8601 timestamp. */
  installedAt: string;
}

export interface PruneOptions {
  /** How many other installs to keep as well, most recently installed first, so going back to one needs no download. */
  spare?: number;
}

/** Written into each install once it has passed every check. An install without one isn't an install. */
const InstallRecordSchema = z.object({
  manifest: ManifestSchema,
  /** The executable, relative to the install's `files/`. */
  path: z.string(),
  installedAt: z.string()
});
type InstallRecord = z.output<typeof InstallRecordSchema>;

const RECORD = 'install.json';
const STAGING = '.staging-';

/**
 * Binaries vendored into a directory, any number of versions of each side by side:
 *
 * ```
 * <directory>/<name>/<version>-<checksum>/install.json
 *                                         files/…
 * ```
 *
 * Each install is downloaded and checked against its checksum, unpacked, made executable and put through the store's
 * checks, all in a staging folder. Only then is its record written and the folder renamed into place. So an install
 * interrupted at any point (an abort, a dropped connection, the process being killed) leaves nothing that looks
 * installed; the next install starts again, and the next prune clears up what was left.
 *
 * One store per directory: two processes installing into the same directory at once aren't guarded against.
 */
export class BinaryStore {
  private readonly unpackers: Record<Format, Unpack>;
  private readonly checks: Check[];
  private readonly fetch: Fetch;
  /** Staging folders of installs still running in this process, which a prune must leave alone. */
  private readonly staging = new Set<string>();

  constructor(private readonly options: BinaryStoreOptions) {
    this.unpackers = { ...unpackers, ...options.unpackers };
    this.checks = options.checks ?? [];
    this.fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
  }

  /** This platform's install of `manifest`, downloading it if it isn't installed yet. */
  async install(manifest: Manifest, signal: AbortSignal): Promise<Installed> {
    const found = await this.find(manifest);
    if (found !== undefined) return found;

    const artifact = artifactFor(manifest);
    const folder = this.folder(manifest);
    const staging = join(this.options.directory, manifest.name, `${STAGING}${randomUUID()}`);
    this.staging.add(staging);
    try {
      const files = join(staging, 'files');
      await mkdir(files, { recursive: true });
      const downloaded = join(staging, 'download');
      await download(artifact, downloaded, this.fetch, signal);
      await this.unpackers[artifact.format]({ download: downloaded, into: files, path: artifact.path, signal });
      await rm(downloaded, { force: true });

      const executable = join(files, artifact.path);
      if (!(await exists(executable))) throw new Error(`${artifact.url} has no ${artifact.path} in it`);
      await chmod(executable, 0o755);
      for (const check of this.checks) await check({ manifest, path: executable, signal });

      const record: InstallRecord = { manifest, path: artifact.path, installedAt: new Date().toISOString() };
      await writeFile(join(staging, RECORD), JSON.stringify(record, null, 2));
      await rename(staging, folder).catch(async (error: Error) => {
        // Another install of the same download finished first. Fine, if it really did.
        if ((await this.find(manifest)) === undefined) throw error;
      });
      const installed = await this.find(manifest);
      if (installed === undefined) throw new Error(`${manifest.name} ${manifest.version} vanished once installed`);
      return installed;
    } finally {
      this.staging.delete(staging);
      await rm(staging, { recursive: true, force: true });
    }
  }

  /** This platform's install of `manifest`, if it's installed. */
  async find(manifest: Manifest): Promise<Installed | undefined> {
    return this.read(manifest.name, this.id(manifest));
  }

  /** Every install of the binary `name`, most recently installed first. */
  async list(name: string): Promise<Installed[]> {
    const entries = await readdir(join(this.options.directory, name)).catch(() => []);
    const installs = await Promise.all(entries.map(entry => this.read(name, entry)));
    const found = installs.filter(installed => installed !== undefined);
    return found.toSorted((a, b) => b.installedAt.localeCompare(a.installedAt));
  }

  /**
   * Removes every install of `keep`'s binary but `keep` (and any spares), along with anything left half-installed by
   * an interrupted install.
   */
  async prune(keep: Installed, options: PruneOptions = {}): Promise<void> {
    const installs = await this.list(keep.name);
    const spares = installs.filter(installed => installed.id !== keep.id).slice(0, options.spare ?? 0);
    const kept = new Set([keep.id, ...spares.map(installed => installed.id)]);
    const root = join(this.options.directory, keep.name);
    const entries = await readdir(root).catch(() => []);
    const stale = entries.filter(entry => !kept.has(entry) && !this.staging.has(join(root, entry)));
    await Promise.all(stale.map(entry => rm(join(root, entry), { recursive: true, force: true })));
  }

  /** Removes every install of the binary `name`. */
  async remove(name: string): Promise<void> {
    await rm(join(this.options.directory, name), { recursive: true, force: true });
  }

  /** Removes every install of every binary. */
  async clear(): Promise<void> {
    await rm(this.options.directory, { recursive: true, force: true });
  }

  private id(manifest: Manifest): string {
    const artifact = artifactFor(manifest);
    return `${manifest.version}-${artifact.checksum.split(':')[1]?.slice(0, 16)}`;
  }

  private folder(manifest: Manifest): string {
    return join(this.options.directory, manifest.name, this.id(manifest));
  }

  private async read(name: string, id: string): Promise<Installed | undefined> {
    if (id.startsWith(STAGING)) return undefined;
    const folder = join(this.options.directory, name, id);
    const record = await readRecord(join(folder, RECORD));
    if (record === undefined) return undefined;
    const path = join(folder, 'files', record.path);
    if (!(await exists(path))) return undefined;
    return { name, version: record.manifest.version, id, path, installedAt: record.installedAt };
  }
}

/** An install's record, or `undefined` if it's missing, cut short or not a record at all. */
async function readRecord(path: string): Promise<InstallRecord | undefined> {
  try {
    const record: InstallRecord = InstallRecordSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    return record;
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  );
}
