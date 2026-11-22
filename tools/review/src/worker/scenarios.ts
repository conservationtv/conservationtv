import { Hono, type Context } from 'hono';

import { GitHubError, IssueCommentsSchema, type IssueComments } from './github.ts';
import { allPages } from './pulls.ts';
import type { AppEnv } from './session.ts';

// A pull request's scenario report (apps/studio/scenarios), served from the GitHub Actions artifact
// `.github/workflows/scenarios.yml` uploads, so it opens in the browser rather than as a zip to download. GitHub hands
// out an artifact only as a zip, through a short-lived signed URL that answers byte ranges; so the zip's central
// directory is read once from its end, and each file asked for is read alone from its offset and inflated as it
// streams. A report of a hundred megabytes of screenshots then costs only what is looked at.
//
// The report is HTML a pull request's code wrote, so it is never trusted with this site: every file is served under a
// sandbox without `allow-same-origin`, giving the page an opaque origin that can neither read this site's cookies nor
// act as the signed-in reviewer. Its images load all the same, and the artifact is read with this tool's own token.

/** The comment the workflow keeps, naming the artifact it uploaded and the commit it captured. */
const SCENARIOS_MARKER = /<!-- scenarios artifact=([0-9]+) sha=([0-9a-f]{40}) -->/;
/** Only the workflow's own comments count, so no one else can point the link at another artifact. */
const SCENARIOS_AUTHOR = 'github-actions[bot]';

/** How long GitHub's signed download URL is used for: it is valid for about a minute. */
const SIGNED_URL_MS = 45_000;
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
/** The end of central directory record, and the longest comment that may follow it. */
const EOCD_SEARCH = 22 + 0xffff;

/** A file in the zip: where its local header starts, how many bytes its data is, and how it is compressed. */
interface Entry {
  offset: number;
  size: number;
  /** 0 stored, 8 deflated. */
  method: number;
}

const TYPES = {
  html: 'text/html; charset=utf-8',
  json: 'application/json',
  png: 'image/png',
  webp: 'image/webp',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8'
} satisfies Record<string, string>;

/** A file's media type, by its extension. */
function typeOf(path: string): string {
  const extension = path.split('.').pop() ?? '';
  // SAFETY: hasOwn has just checked the extension is one of TYPES' own keys.
  return Object.hasOwn(TYPES, extension) ? TYPES[extension as keyof typeof TYPES] : 'application/octet-stream';
}

/** GitHub's signed URL for an artifact, and when it was handed out. */
interface SignedUrl {
  url: string;
  at: number;
}

/** Where the central directory sits in the zip. */
interface Span {
  offset: number;
  length: number;
}

/** Served with every file: never this site's origin, and the artifact never changes. */
const UNTRUSTED_HEADERS = {
  'content-security-policy': 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox',
  'x-content-type-options': 'nosniff',
  'cache-control': 'public, max-age=31536000, immutable'
};

const signedUrls = new Map<string, SignedUrl>();

/** Where the artifact's zip can be read for the next minute, from GitHub's redirect. */
async function signedUrl(c: Context<AppEnv>, artifact: string): Promise<string> {
  const known = signedUrls.get(artifact);
  if (known && Date.now() - known.at < SIGNED_URL_MS) return known.url;
  const response = await fetch(
    `https://api.github.com/repos/${c.env.GITHUB_REPOSITORY}/actions/artifacts/${artifact}/zip`,
    {
      redirect: 'manual',
      headers: {
        authorization: `Bearer ${c.env.GITHUB_TOKEN}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'review.tools.conservation.tv',
        'x-github-api-version': '2022-11-28'
      }
    }
  );
  const location = response.headers.get('location');
  if (response.status === 404 || response.status === 410) {
    throw new GitHubError(404, 'This report has expired, or never existed.');
  }
  if (!location) throw new GitHubError(502, `GitHub would not hand over the report (${response.status}).`);
  signedUrls.set(artifact, { url: location, at: Date.now() });
  return location;
}

/** Bytes `start` to `end` inclusive of the zip, as a response to stream or read. */
async function range(url: string, start: number, end: number): Promise<Response> {
  const response = await fetch(url, { headers: { range: `bytes=${start}-${end}` } });
  if (response.status !== 206) throw new GitHubError(502, `The report's storage answered ${response.status}.`);
  return response;
}

async function bytes(url: string, start: number, end: number): Promise<DataView> {
  return new DataView(await (await range(url, start, end)).arrayBuffer());
}

/** The zip's length, from a one-byte read: the storage ignores ranges counted from the end. */
async function sizeOf(url: string): Promise<number> {
  const response = await range(url, 0, 0);
  const total = Number(response.headers.get('content-range')?.split('/')[1]);
  if (!Number.isFinite(total)) throw new GitHubError(502, "The report's storage didn't say how long it is.");
  return total;
}

/** The central directory's offset and length, from the end of central directory record. */
async function centralDirectory(url: string): Promise<Span> {
  const size = await sizeOf(url);
  const start = Math.max(0, size - EOCD_SEARCH);
  const tail = await bytes(url, start, size - 1);
  // The record is the last thing in the zip but for its comment: search back for its signature.
  for (let at = tail.byteLength - 22; at >= 0; at--) {
    if (tail.getUint32(at, true) !== EOCD_SIGNATURE) continue;
    const length = tail.getUint32(at + 12, true);
    const offset = tail.getUint32(at + 16, true);
    // ZIP64 marks these as all ones: a report is far smaller than the 4 GB that needs it.
    if (offset === 0xffffffff) throw new GitHubError(502, 'The report is too large to read.');
    return { offset, length };
  }
  throw new GitHubError(502, 'The report is not a zip.');
}

/** Every file in the zip, by path, from its central directory. */
async function readDirectory(url: string): Promise<Record<string, Entry>> {
  const { offset, length } = await centralDirectory(url);
  const view = await bytes(url, offset, offset + length - 1);
  const decoder = new TextDecoder();
  const entries: Record<string, Entry> = {};
  for (let at = 0; at + 46 <= view.byteLength && view.getUint32(at, true) === CENTRAL_SIGNATURE;) {
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const name = decoder.decode(new Uint8Array(view.buffer, view.byteOffset + at + 46, nameLength));
    entries[name] = {
      method: view.getUint16(at + 10, true),
      size: view.getUint32(at + 20, true),
      offset: view.getUint32(at + 42, true)
    };
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** The artifact's directory, read once and kept: an artifact never changes. */
async function directory(c: Context<AppEnv>, artifact: string): Promise<Record<string, Entry>> {
  const key = new Request(`${new URL(c.req.url).origin}/__scenarios/${artifact}/directory`);
  const hit = await caches.default.match(key);
  if (hit) return hit.json();
  const entries = await readDirectory(await signedUrl(c, artifact));
  const stored = new Response(JSON.stringify(entries), { headers: { 'cache-control': 'max-age=31536000' } });
  c.executionCtx.waitUntil(caches.default.put(key, stored));
  return entries;
}

/** One file of the zip, streamed and inflated as it comes. */
async function file(c: Context<AppEnv>, artifact: string, entry: Entry): Promise<ReadableStream<Uint8Array>> {
  const url = await signedUrl(c, artifact);
  // The local header's name and extra field may differ in length from the central directory's.
  const header = await bytes(url, entry.offset, entry.offset + 29);
  const start = entry.offset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
  const body = (await range(url, start, start + entry.size - 1)).body;
  if (!body) throw new GitHubError(502, "The report's storage sent nothing.");
  if (entry.method === 0) return body;
  if (entry.method === 8) return body.pipeThrough(new DecompressionStream('deflate-raw'));
  throw new GitHubError(502, `The report holds a file compressed in a way this can't read (${entry.method}).`);
}

/** The latest report the workflow named in the pull request's comments. */
function latestArtifact(comments: IssueComments): string | null {
  const named = comments
    .filter(comment => comment.user.login === SCENARIOS_AUTHOR)
    .map(comment => comment.body?.match(SCENARIOS_MARKER)?.[1])
    .filter(artifact => artifact !== undefined);
  return named.at(-1) ?? null;
}

export const scenarios = new Hono<AppEnv>()
  // The pull request's latest report: a stable link for the comment and the review page.
  .get('/pulls/:number{[0-9]+}/scenarios', async c => {
    const comments = await allPages(`issues/${c.req.param('number')}/comments`, IssueCommentsSchema, 'live');
    const artifact = latestArtifact(comments);
    if (!artifact) return c.json({ error: 'No scenario report has been made for this pull request yet.' }, 404);
    return c.redirect(`/api/scenarios/${artifact}/index.html`, 302);
  })
  // A file of a report: from the cache once read, otherwise out of the zip, by the path the report links it by.
  .get('/scenarios/:artifact{[0-9]+}/:path{.+}', async c => {
    const cached = await caches.default.match(c.req.raw);
    if (cached) return cached;
    const artifact = c.req.param('artifact');
    const path = c.req.param('path');
    const entry = (await directory(c, artifact))[path];
    if (!entry) return c.json({ error: 'No such file in this report.' }, 404);
    const headers = { ...UNTRUSTED_HEADERS, 'content-type': typeOf(path) };
    const [served, kept] = (await file(c, artifact, entry)).tee();
    c.executionCtx.waitUntil(caches.default.put(c.req.raw, new Response(kept, { headers })));
    return new Response(served, { headers });
  });
