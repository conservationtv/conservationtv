import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Binary } from './binary.ts';
import { type Fetch, download } from './download.ts';
import { type Manifest, artifactFor } from './manifest.ts';
import { type InstallRecord, InstallRecordSchema, type Persistence, jsonFile } from './persistence.ts';

export interface BinaryStoreOptions {
  /** A directory of the store's own. Each binary gets a folder in it, with each version installed beside the others. */
  directory: string;
  /** How downloads are fetched. `globalThis.fetch` by default. */
  fetch?: Fetch;
  /** Where the records of what's installed are kept. `.installs.json` in `directory` by default. */
  persistence?: Persistence;
}

/** A binary installed and ready to run. */
export interface Installed {
  name: string;
  version: string;
  /** Tells installs apart: two downloads claiming the same version but with different checksums are different. */
  id: string;
  /** The executable. */
  path: string;
  /**
   * Everything the download unpacked to. Some binaries need what came beside them: mediamtx reads the `mediamtx.yml`
   * next to it only when run from here, and Node's `npm` needs Node's `bin/` on its `PATH`.
   */
  directory: string;
  /** When it was installed, as an ISO 8601 timestamp. */
  installedAt: string;
}

export interface PruneOptions {
  /** How many other installs to keep as well, most recently installed first, so going back to one needs no download. */
  spare?: number;
}

const STAGING = '.staging-';

/**
 * Binaries vendored into a directory, any number of versions of each side by side:
 *
 * ```
 * <directory>/<name>/<version>-<checksum>/…   what the download unpacked to
 * ```
 *
 * What's installed is known from its records, kept by the store's persistence. Each install is downloaded and
 * checked against its checksum, then unpacked, made executable and put through its binary's checks, all in a staging
 * folder. Only then is it moved into place and its record saved. A folder without a record is what an interrupted
 * install left behind: it's never taken for an install, and the next prune removes it.
 *
 * Changes to the records happen one at a time, in the order they're made, and a lookup sees every change asked for
 * before it. Downloading and unpacking happen outside that order, so installs still run side by side. One store per
 * directory: two processes
 * installing into the same directory at once aren't guarded against.
 */
export class BinaryStore {
  private readonly fetch: Fetch;
  private readonly persistence: Persistence;
  /** Staging folders of installs still running in this process, which a prune must leave alone. */
  private readonly staging = new Set<string>();
  /** The records as last saved. */
  private records: InstallRecord[] = [];
  private restoring: Promise<void> | undefined = undefined;
  private changes: Promise<void> = Promise.resolve();

  constructor(private readonly options: BinaryStoreOptions) {
    this.fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.persistence = options.persistence ?? jsonFile(join(options.directory, '.installs.json'));
  }

  /** This platform's install of `binary` at `manifest`, downloading it if it isn't installed yet. */
  async install(binary: Binary, manifest: Manifest, signal: AbortSignal): Promise<Installed> {
    if (manifest.name !== binary.name) throw new Error(`A ${manifest.name} manifest can't install ${binary.name}`);
    const found = await this.find(manifest);
    if (found !== undefined) return found;

    const artifact = artifactFor(manifest);
    const unpack = binary.unpackers[artifact.format];
    if (unpack === undefined) throw new Error(`${binary.name} has no unpacker for the format "${artifact.format}"`);
    const staging = join(this.options.directory, manifest.name, `${STAGING}${randomUUID()}`);
    this.staging.add(staging);
    try {
      const files = join(staging, 'files');
      await mkdir(files, { recursive: true });
      const downloaded = join(staging, 'download');
      await download(artifact, downloaded, this.fetch, signal);
      await unpack({ download: downloaded, into: files, path: artifact.path, signal });

      const executable = join(files, artifact.path);
      if (!(await exists(executable))) throw new Error(`${artifact.url} has no ${artifact.path} in it`);
      await chmod(executable, 0o755);
      for (const check of binary.checks) await check({ manifest, path: executable, signal });

      const record: InstallRecord = {
        name: manifest.name,
        id: idOf(manifest),
        manifest,
        path: artifact.path,
        installedAt: new Date().toISOString()
      };
      return await this.commit(record, files);
    } finally {
      this.staging.delete(staging);
      await rm(staging, { recursive: true, force: true });
    }
  }

  /** This platform's install of `manifest`, if it's installed once every change already asked for has happened. */
  async find(manifest: Manifest): Promise<Installed | undefined> {
    return this.serially(async () => {
      const record = this.recordOf(manifest.name, idOf(manifest));
      if (record === undefined || !(await exists(this.executable(record)))) return undefined;
      return this.installed(record);
    });
  }

  /** Every install of the binary `name`, most recently installed first. */
  async list(name: string): Promise<Installed[]> {
    return this.serially(async () => this.newestFirst(name).map(record => this.installed(record)));
  }

  /**
   * Removes every install of `keep`'s binary but `keep` (and any spares), along with anything left half-installed by
   * an interrupted install.
   */
  async prune(keep: Installed, options: PruneOptions = {}): Promise<void> {
    await this.serially(async () => {
      const spares = this.newestFirst(keep.name)
        .filter(record => record.id !== keep.id)
        .slice(0, options.spare ?? 0);
      const kept = new Set([keep.id, ...spares.map(record => record.id)]);
      await this.save(this.records.filter(record => record.name !== keep.name || kept.has(record.id)));
      const root = join(this.options.directory, keep.name);
      const entries = await readdir(root).catch(() => []);
      const stale = entries.filter(entry => !kept.has(entry) && !this.staging.has(join(root, entry)));
      await Promise.all(stale.map(entry => rm(join(root, entry), { recursive: true, force: true })));
    });
  }

  /** Removes every install of the binary `name`. */
  async remove(name: string): Promise<void> {
    await this.serially(async () => {
      await this.save(this.records.filter(record => record.name !== name));
      await rm(join(this.options.directory, name), { recursive: true, force: true });
    });
  }

  /** Removes every install of every binary. */
  async clear(): Promise<void> {
    await this.serially(async () => {
      await this.save([]);
      await rm(this.options.directory, { recursive: true, force: true });
    });
  }

  /**
   * Moves a finished install's files into place, then saves its record. Another install of the same download may
   * have got there first; if so, that one is used.
   */
  private async commit(record: InstallRecord, files: string): Promise<Installed> {
    return this.serially(async () => {
      const existing = this.recordOf(record.name, record.id);
      if (existing !== undefined && (await exists(this.executable(existing)))) return this.installed(existing);
      const folder = this.folder(record);
      // Anything already here has no record: an install interrupted after moving its files, before saving.
      await rm(folder, { recursive: true, force: true });
      await rename(files, folder);
      const others = this.records.filter(other => other.name !== record.name || other.id !== record.id);
      await this.save([...others, record]);
      return this.installed(record);
    });
  }

  /** Runs `change` after every change and lookup before it, with the records restored. */
  private async serially<T>(change: () => Promise<T>): Promise<T> {
    const result = this.changes.then(async () => {
      await this.restored();
      return change();
    });
    this.changes = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /** Restores the records the first time they're needed, dropping any whose files have gone. */
  private async restored(): Promise<void> {
    if (this.restoring === undefined) {
      this.restoring = this.restore().catch((error: Error) => {
        // Not restored: the next use tries again.
        this.restoring = undefined;
        throw error;
      });
    }
    await this.restoring;
  }

  private async restore(): Promise<void> {
    const records = InstallRecordSchema.array().parse(await this.persistence.restore());
    const present = await Promise.all(records.map(record => exists(this.executable(record))));
    this.records = records.filter((_, index) => present[index]);
  }

  private async save(records: InstallRecord[]): Promise<void> {
    await this.persistence.sink(records);
    this.records = records;
  }

  private recordOf(name: string, id: string): InstallRecord | undefined {
    return this.records.find(record => record.name === name && record.id === id);
  }

  private newestFirst(name: string): InstallRecord[] {
    const records = this.records.filter(record => record.name === name);
    return records.toSorted((a, b) => b.installedAt.localeCompare(a.installedAt));
  }

  private folder(record: InstallRecord): string {
    return join(this.options.directory, record.name, record.id);
  }

  private executable(record: InstallRecord): string {
    return join(this.folder(record), record.path);
  }

  private installed(record: InstallRecord): Installed {
    const { name, id, installedAt } = record;
    const version = record.manifest.version;
    return { name, version, id, path: this.executable(record), directory: this.folder(record), installedAt };
  }
}

/** An install's id: its version, and enough of its checksum to tell re-published downloads apart. */
function idOf(manifest: Manifest): string {
  const artifact = artifactFor(manifest);
  return `${manifest.version}-${artifact.checksum.split(':')[1]?.slice(0, 16)}`;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  );
}
