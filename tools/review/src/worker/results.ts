import { LOG_FILE, RESULT_FILE, RunResultSchema, type RunResult } from '@conservationtv/runner/results';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { GitHubError } from './github.ts';
import type { AppEnv } from './session.ts';

// Signoff runs from developers' machines (tools/runner): each run's log, reports and result, kept in R2 under
// `<commit>/<signoff>/<file>`. Anyone reads them, as they read the pull request; only someone who can push to the
// repository writes them, proving it with their GitHub token (`gh auth token`) as a bearer token, so no secret of this
// tool's is handed out. What a run wrote is a pull request's code's output, so its HTML is served sandboxed.

const SHA = '[0-9a-f]{40}';
const NAME = '[a-z][a-z0-9-]*';
/** Paths within a run: no leading slash, no `..`. */
const FILE = /^(?!.*\.\.)[A-Za-z0-9._-][A-Za-z0-9._/-]*$/;
/** The largest file a run may upload. */
const MAX_BYTES = 50 * 1024 * 1024;
/** How long a checked token is trusted for before GitHub is asked again. */
const TRUSTED_FOR_SECONDS = 600;

const TYPES = new Map([
  ['txt', 'text/plain; charset=utf-8'],
  ['json', 'application/json'],
  ['html', 'text/html; charset=utf-8'],
  ['png', 'image/png'],
  ['webp', 'image/webp'],
  ['jpg', 'image/jpeg'],
  ['js', 'text/javascript; charset=utf-8'],
  ['css', 'text/css; charset=utf-8']
]);

function typeOf(path: string): string {
  return TYPES.get(path.split('.').pop() ?? '') ?? 'application/octet-stream';
}

/** Served with everything a run wrote: never this site's origin, and a run never changes once complete. */
const UNTRUSTED_HEADERS = {
  'content-security-policy': 'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox',
  'x-content-type-options': 'nosniff'
};

const UserSchema = z.object({ login: z.string() });
type User = z.output<typeof UserSchema>;
const PermissionSchema = z.object({ permission: z.string() });
type Permission = z.output<typeof PermissionSchema>;

/** The roles that can push, and so sign a commit off. */
const WRITERS = new Set(['admin', 'maintain', 'write']);

async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** GitHub's answer to a request made with the uploader's own token. */
async function asUploader<T extends z.ZodType>(token: string, url: string, schema: T): Promise<z.output<T>> {
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'review.tools.conservation.tv'
    }
  });
  if (!response.ok) throw new GitHubError(401, 'GitHub did not accept that token.');
  return schema.parse(await response.json());
}

/**
 * Who is uploading: the bearer token's GitHub login, when it can push to the repository. Checked with GitHub, then
 * trusted for a few minutes by the token's digest, so a run's dozens of files cost two requests.
 */
async function uploader(c: Context<AppEnv>): Promise<string> {
  const token = c.req.header('authorization')?.match(/^Bearer (\S+)$/)?.[1];
  if (!token) throw new GitHubError(401, 'Upload with a GitHub token: Authorization: Bearer $(gh auth token).');
  const key = new Request(`https://review.internal/uploaders/${await digest(token)}`);
  const known = await caches.default.match(key);
  if (known) return known.text();
  const { login }: User = await asUploader(token, 'https://api.github.com/user', UserSchema);
  const url = `https://api.github.com/repos/${c.env.GITHUB_REPOSITORY}/collaborators/${login}/permission`;
  const { permission }: Permission = await asUploader(token, url, PermissionSchema);
  if (!WRITERS.has(permission)) throw new GitHubError(403, `${login} cannot push to ${c.env.GITHUB_REPOSITORY}.`);
  const trusted = new Response(login, { headers: { 'cache-control': `max-age=${TRUSTED_FOR_SECONDS}` } });
  c.executionCtx.waitUntil(caches.default.put(key, trusted));
  return login;
}

/** A run's result as uploaded, with who ran it set from the token rather than taken from the upload. */
async function resultFrom(c: Context<AppEnv>, login: string): Promise<RunResult> {
  const result = RunResultSchema.parse(await c.req.json());
  const { sha, signoff } = c.req.param();
  if (result.sha !== sha || result.signoff !== signoff) throw new GitHubError(400, 'The result is of another run.');
  return { ...result, ranBy: login };
}

export const results = new Hono<AppEnv>()
  .put(`/results/:sha{${SHA}}/:signoff{${NAME}}/:file{.+}`, async c => {
    // A file of a run, checked for its path and size before its uploader; then stored as it comes, except the result,
    // which is stamped with who ran it and the files uploaded before it.
    const { sha, signoff, file } = c.req.param();
    if (!FILE.test(file)) return c.json({ error: 'Not a file of a run.' }, 400);
    if (Number(c.req.header('content-length') ?? 0) > MAX_BYTES) return c.json({ error: 'Too large.' }, 413);
    const login = await uploader(c);
    const key = `${sha}/${signoff}/${file}`;
    if (file === RESULT_FILE) {
      const result = await resultFrom(c, login);
      // The files it lists are whatever the run uploaded before it.
      const listed = await c.env.RESULTS.list({ prefix: `${sha}/${signoff}/` });
      const files = listed.objects.map(object => object.key.slice(key.length - file.length));
      const complete = { ...result, files: files.filter(path => path !== RESULT_FILE && path !== LOG_FILE) };
      await c.env.RESULTS.put(key, JSON.stringify(complete), { httpMetadata: { contentType: typeOf(file) } });
      return c.body(null, 204);
    }
    await c.env.RESULTS.put(key, c.req.raw.body, { httpMetadata: { contentType: typeOf(file) } });
    return c.body(null, 204);
  })
  // Every signoff's result at a commit; a run without its result.json is still uploading, or was abandoned.
  .get(`/results/:sha{${SHA}}`, async c => {
    const { sha } = c.req.param();
    const listed = await c.env.RESULTS.list({ prefix: `${sha}/` });
    const keys = listed.objects.map(object => object.key).filter(key => key.endsWith(`/${RESULT_FILE}`));
    const runs = await Promise.all(
      keys.map(async key => RunResultSchema.parse(await (await c.env.RESULTS.get(key))?.json()))
    );
    return c.json(runs, 200, { 'cache-control': 'no-store' });
  })
  .get(`/results/:sha{${SHA}}/:signoff{${NAME}}/:file{.+}`, async c => {
    const { sha, signoff, file } = c.req.param();
    if (!FILE.test(file)) return c.json({ error: 'Not a file of a run.' }, 400);
    const object = await c.env.RESULTS.get(`${sha}/${signoff}/${file}`);
    if (!object) return c.json({ error: 'Not found.' }, 404);
    return new Response(object.body, {
      headers: { ...UNTRUSTED_HEADERS, 'content-type': typeOf(file), 'cache-control': 'no-cache' }
    });
  });
