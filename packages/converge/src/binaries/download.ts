import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
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
  // Read with the web API explicitly: consumers can load both DOM and Node stream declarations.
  const body = response.body;
  const chunks = async function* () {
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  };
  await pipeline(Readable.from(chunks()), hashing, createWriteStream(path), { signal });
  if (hash.digest('hex') !== expected) throw new Error(`${artifact.url} doesn't match its checksum`);
}
