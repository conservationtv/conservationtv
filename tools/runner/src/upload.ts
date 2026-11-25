import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

// Uploading a run to the review tool (tools/review, src/worker/results.ts). Files a report wrote to disk (screenshots,
// mostly) are stored there by their content: each is hashed, the review tool says which contents it hasn't got, only
// those are sent, once each, and a manifest maps the run's paths to the rest. A re-run, or a pull request whose screens
// didn't change, sends next to nothing. Everything else (logs, JSON) is sent under its own path.

/** A file a report wrote, held in memory: its name under the run, and what it holds. */
export interface WrittenUpload {
  name: string;
  body: string;
}

/** A file a report wrote to disk: its name under the run, and where it is. */
export interface FileUpload {
  name: string;
  path: string;
}

export type Upload = WrittenUpload | FileUpload;

/** Where a run goes: the review tool, the GitHub token it checks, and the run's commit and name. */
export interface Destination {
  reviewUrl: string;
  token: string;
  sha: string;
  run: string;
}

/** How many requests go at once, and how many hashes are asked about in one. */
const AT_ONCE = 8;
const BATCH = 500;
const MANIFEST_FILE = 'manifest.json';

const MissingSchema = z.object({ missing: z.array(z.string()) });
type Missing = z.output<typeof MissingSchema>;

const TYPES = new Map([
  ['png', 'image/png'],
  ['webp', 'image/webp'],
  ['jpg', 'image/jpeg'],
  // A page's accessibility snapshot, one beside each screenshot.
  ['txt', 'text/plain; charset=utf-8']
]);

async function request(to: Destination, method: string, path: string, body: string | Uint8Array, type: string) {
  const response = await fetch(`${to.reviewUrl}/api/results/${path}`, {
    method,
    headers: { authorization: `Bearer ${to.token}`, 'content-type': type },
    body
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return response;
}

/** One file of the run, under its own path. */
export async function putFile(to: Destination, name: string, body: string | Uint8Array): Promise<void> {
  await request(to, 'PUT', `${to.sha}/${to.run}/${name}`, body, 'application/octet-stream');
}

/** Runs `task` over `items`, `limit` at a time. */
async function inBatches<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  for (let index = 0; index < items.length; index += limit) {
    await Promise.all(items.slice(index, index + limit).map(task));
  }
}

/** The contents among `hashes` the review tool hasn't got. */
async function missing(to: Destination, hashes: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let index = 0; index < hashes.length; index += BATCH) {
    // A batch at a time: each hash is a lookup for the review tool.
    const body = JSON.stringify({ hashes: hashes.slice(index, index + BATCH) });
    const response = await request(to, 'POST', 'blobs/missing', body, 'application/json');
    const answer: Missing = MissingSchema.parse(await response.json());
    for (const md5 of answer.missing) found.add(md5);
  }
  return found;
}

/** What uploading sent: files sent, and files the review tool had already, by content. */
export interface Sent {
  sent: number;
  reused: number;
}

/** A file on disk, read and hashed, with the type it is served as. */
interface Hashed {
  upload: FileUpload;
  bytes: Buffer;
  md5: string;
  type: string;
}

/** Whether a file is stored by its content: images and snapshots a report wrote to disk; its JSON goes under its own path. */
function byContent(upload: Upload): upload is FileUpload {
  return 'path' in upload && TYPES.has(upload.name.split('.').pop() ?? '');
}

/** Uploads a run's files: images by content, sending only what the review tool hasn't got, the rest by path. */
export async function uploadRun(to: Destination, uploads: readonly Upload[]): Promise<Sent> {
  const hashed: Hashed[] = uploads.filter(byContent).map(upload => {
    const bytes = readFileSync(upload.path);
    const md5 = createHash('md5').update(bytes).digest('hex');
    return { upload, bytes, md5, type: TYPES.get(upload.name.split('.').pop() ?? '') ?? 'application/octet-stream' };
  });
  const absent = await missing(to, [...new Set(hashed.map(file => file.md5))]);
  // Each missing content once, however many paths share it.
  const toSend = [...new Map(hashed.filter(file => absent.has(file.md5)).map(file => [file.md5, file])).values()];
  await inBatches(toSend, AT_ONCE, file =>
    request(to, 'PUT', `blobs/${file.md5}`, file.bytes, file.type).then(() => undefined)
  );
  if (hashed.length) {
    const manifest = Object.fromEntries(hashed.map(file => [file.upload.name, file.md5]));
    await putFile(to, MANIFEST_FILE, JSON.stringify(manifest));
  }
  const byPath = uploads.filter(upload => !byContent(upload));
  await inBatches(byPath, AT_ONCE, upload =>
    putFile(to, upload.name, 'body' in upload ? upload.body : readFileSync(upload.path))
  );
  return { sent: toSend.length + byPath.length, reused: hashed.length - toSend.length };
}
