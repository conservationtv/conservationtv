import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { createGunzip } from 'node:zlib';

const run = promisify(execFile);

/** What an unpacker is handed: a verified download, and an empty folder to unpack it into. */
export interface Unpacking {
  /** The download, already checked against its checksum. */
  download: string;
  /** An empty folder for the unpacked files. */
  into: string;
  /** Where in `into` the executable is expected, for formats that hold only the binary. */
  path: string;
  signal: AbortSignal;
}

/** Unpacks a download into a folder. */
export type Unpack = (unpacking: Unpacking) => Promise<void>;

/** The download is the binary itself. */
export const file: Unpack = async ({ download, into, path }) => {
  await mkdir(dirname(join(into, path)), { recursive: true });
  await rename(download, join(into, path));
};

/** The download is the binary, gzipped. */
export const gzip: Unpack = async ({ download, into, path, signal }) => {
  await mkdir(dirname(join(into, path)), { recursive: true });
  await pipeline(createReadStream(download), createGunzip(), createWriteStream(join(into, path)), { signal });
};

/**
 * The download is the binary, bzip2'd, as restic ships. Node can't read bzip2, so this uses the system's `bzip2`, which
 * macOS and most Linux distributions have, but Windows doesn't.
 */
export const bzip2: Unpack = async ({ download, into, path, signal }) => {
  const compressed = `${join(into, path)}.bz2`;
  await mkdir(dirname(compressed), { recursive: true });
  await rename(download, compressed);
  await run('bzip2', ['-d', compressed], { signal });
};

/**
 * A tarball, with any compression the system's `tar` reads. That `tar` ships with macOS, Linux and Windows 10+, and
 * works the compression out for itself when extracting.
 */
export const tar: Unpack = async ({ download, into, signal }) => {
  await run('tar', ['-xf', download, '-C', into], { signal });
};

/** A zip. The system's `tar` reads these on macOS and Windows; Linux's usually doesn't, so `unzip` there. */
export const zip: Unpack = async ({ download, into, signal }) => {
  if (process.platform === 'linux') await run('unzip', ['-q', download, '-d', into], { signal });
  else await run('tar', ['-xf', download, '-C', into], { signal });
};

/** The unpacker for each format a binary can unpack, unless its definition adds others. */
export const unpackers = { file, gzip, bzip2, tar, zip } satisfies Record<string, Unpack>;
