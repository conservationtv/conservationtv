import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';
import type { Artifact } from './manifest.ts';

/** Fetches a URL. `globalThis.fetch` unless a store is given another, to add credentials or go through a mirror. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** Downloads `artifact` to `path`, hashing as it goes, and throws if the checksum doesn't match. */
export async function download(artifact: Artifact, path: string, fetch: Fetch, signal: AbortSignal): Promise<void> {
  const [algorithm = 'sha256', expected] = artifact.checksum.split(':');
  const response = await fetch(artifact.url, { signal });
  if (!response.ok || response.body === null) throw new Error(`Downloading ${artifact.url} failed: ${response.status}`);
  const hash = createHash(algorithm);
  const hashing = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      done(null, chunk);
    }
  });
  // SAFETY: a fetched body is Node's own web stream, whatever `ReadableStream` the importer's `lib` resolves to; the
  // DOM typing's BYOB reader differs from Node's, so under `DOM` it isn't assignable to what `fromWeb` takes.
  const body = response.body as ReadableStream;
  await pipeline(Readable.fromWeb(body), hashing, createWriteStream(path), { signal });
  if (hash.digest('hex') !== expected) throw new Error(`${artifact.url} doesn't match its checksum`);
}
