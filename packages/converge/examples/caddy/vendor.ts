import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execa } from 'execa';
import { z } from 'zod';

/** One platform's download: where it is, and the checksum it must match before anything runs it. */
export const ArtifactSchema = z.object({
  /** A `.tar.gz`, `.tgz` or `.zip` archive holding the binary, or the binary itself. */
  url: z.url(),
  /** The archive's checksum, as `sha256:<hex>` or `sha512:<hex>`. */
  checksum: z.string().regex(/^sha(256|512):[0-9a-f]+$/)
});
export type Artifact = z.output<typeof ArtifactSchema>;

/** A version of a binary, with a download for each platform it runs on. */
export const BinarySchema = z.object({
  version: z.string().min(1),
  /** Keyed by `${process.platform}-${process.arch}`, such as `darwin-arm64`, `linux-x64` or `win32-x64`. */
  artifacts: z.record(z.string(), ArtifactSchema)
});
export type Binary = z.output<typeof BinarySchema>;

/** A binary installed and ready to run. */
export interface Installed {
  version: string;
  path: string;
  /** Tells installs apart: two artifacts claiming the same version but with different checksums are different. */
  id: string;
}

/**
 * A store of vendored binaries in a directory of its own. Each install is downloaded, checked against its checksum
 * before it is unpacked, checked that it reports the version it claims, and only then renamed into place. So an
 * install interrupted at any point (a dropped connection, an abort, the agent being killed) leaves nothing that looks
 * installed, and a later install finds a finished one or starts again.
 */
export class Vendor {
  constructor(
    private readonly directory: string,
    /** The binary's file name inside an archive, without `.exe`. */
    private readonly name: string
  ) {}

  /** This platform's install of `binary`, downloading it if it isn't installed yet. */
  async install(binary: Binary, signal: AbortSignal): Promise<Installed> {
    const platform = `${process.platform}-${process.arch}`;
    const artifact = binary.artifacts[platform];
    if (artifact === undefined) throw new Error(`No ${this.name} ${binary.version} download for ${platform}`);
    const id = `${binary.version}-${artifact.checksum.split(':')[1]?.slice(0, 16)}`;
    const folder = join(this.directory, id);
    const path = join(folder, this.executable());
    if (await exists(path)) return { version: binary.version, path, id };

    const staging = join(this.directory, `.staging-${randomUUID()}`);
    try {
      await mkdir(staging, { recursive: true });
      const download = join(staging, 'download');
      await fetchVerified(artifact, download, signal);
      const unpacked = await this.unpack(artifact, download, staging, signal);
      await chmod(unpacked, 0o755);
      await this.checkVersion(unpacked, binary.version, signal);
      await mkdir(folder, { recursive: true });
      await rename(unpacked, path);
      return { version: binary.version, path, id };
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  /** Removes every install but `keep`, and anything left staging by an interrupted install. */
  async prune(keep: Installed): Promise<void> {
    const entries = await readdir(this.directory).catch(() => []);
    const stale = entries.filter(entry => entry !== keep.id);
    await Promise.all(stale.map(entry => rm(join(this.directory, entry), { recursive: true, force: true })));
  }

  /** Removes every install. */
  async clear(): Promise<void> {
    await rm(this.directory, { recursive: true, force: true });
  }

  private executable(): string {
    return process.platform === 'win32' ? `${this.name}.exe` : this.name;
  }

  /** The binary from the download: unpacked with the system's `tar` (which reads `.zip` too on Windows and macOS). */
  private async unpack(artifact: Artifact, download: string, staging: string, signal: AbortSignal): Promise<string> {
    const pathname = new URL(artifact.url).pathname;
    if (!/\.(tar\.gz|tgz|zip)$/.test(pathname)) return download;
    const into = join(staging, 'unpacked');
    await mkdir(into);
    await execa('tar', ['-xf', download, '-C', into], { cancelSignal: signal });
    const binary = join(into, this.executable());
    if (!(await exists(binary))) throw new Error(`${pathname} has no ${this.executable()} at its top level`);
    return binary;
  }

  /** Runs `<binary> version`, so a download that isn't the version the spec asked for is never installed. */
  private async checkVersion(binary: string, version: string, signal: AbortSignal): Promise<void> {
    const { stdout } = await execa(binary, ['version'], { cancelSignal: signal, timeout: 10_000 });
    if (!stdout.replace(/^v/, '').startsWith(version.replace(/^v/, ''))) {
      throw new Error(`Asked for ${this.name} ${version}, but the download reports ${stdout.split(' ')[0]}`);
    }
  }
}

/** Downloads `artifact` to `path`, hashing as it goes, and throws if the checksum doesn't match. */
async function fetchVerified(artifact: Artifact, path: string, signal: AbortSignal): Promise<void> {
  const [algorithm, expected] = artifact.checksum.split(':');
  const response = await fetch(artifact.url, { signal });
  if (!response.ok || response.body === null) throw new Error(`Downloading ${artifact.url} failed: ${response.status}`);
  const hash = createHash(algorithm ?? 'sha256');
  const body = Readable.fromWeb(response.body);
  body.on('data', (chunk: Buffer) => hash.update(chunk));
  await pipeline(body, createWriteStream(path), { signal });
  const actual = hash.digest('hex');
  if (actual !== expected) throw new Error(`${artifact.url} doesn't match its checksum`);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  );
}
