import { Hono } from 'hono';
import { z } from 'zod';
import { actions } from './actions.ts';
import { auth } from './auth.ts';
import { createGitHub, GitHubError, useGitHub, withGitHub } from './github.ts';
import { operationDocs } from './operations.ts';
import { pullList, review } from './pulls.ts';
import { results } from './results.ts';
import { scenarios } from './scenarios.ts';
import { readSession, type AppEnv } from './session.ts';

const SHA = /^[0-9a-f]{40}$/;

const app = new Hono<AppEnv>()
  .basePath('/api')
  // Changes come only from this site's own pages: a signed-in reviewer's cookie must not carry another site's request.
  // Signoff results are the exception: they are uploaded from a terminal with a bearer token, never a cookie.
  .use(async (c, next) => {
    // Reading is anyone's; a change needs this site's own page, or a bearer token where one is the only credential.
    const sameSite = c.req.header('origin') === new URL(c.req.url).origin;
    const bearer = c.req.path.startsWith('/api/results/') && c.req.header('authorization')?.startsWith('Bearer ');
    if (c.req.method === 'GET' || sameSite || bearer) return next();
    return c.json({ error: 'Changes must come from this site.' }, 403);
  })
  // GitHub is read as whoever is signed in, with their own token and rate limit, else with this tool's token, else
  // anonymously. Everything read is public, so cached responses are shared whoever fetched them.
  .use(async (c, next) => {
    const signedIn = await readSession(c);
    const github = createGitHub({
      repository: c.env.GITHUB_REPOSITORY,
      token: signedIn?.token ?? c.env.GITHUB_TOKEN ?? '',
      // Asked for straight after a change, so the change shows.
      fresh: c.req.header('x-review-fresh') !== undefined,
      waitUntil: promise => c.executionCtx.waitUntil(promise)
    });
    await withGitHub(github, next);
  })
  .route('/auth', auth)
  .route('/', actions)
  // A pull request's scenario report, read out of its Actions artifact (src/worker/scenarios.ts).
  .route('/', scenarios)
  // Signoff runs from developers' machines (src/worker/results.ts).
  .route('/', results)
  .get('/pulls', async c => c.json(await pullList(), 200, { 'cache-control': 'no-store' }))
  .get('/pulls/:number{[0-9]+}', async c => {
    const number = Number(c.req.param('number'));
    return c.json(await review(number), 200, { 'cache-control': 'no-store' });
  })
  // One operation of one API document as documentation, before and after: fetched when its page is opened.
  .get('/pulls/:number{[0-9]+}/operations/:operation', async c => {
    const number = Number(c.req.param('number'));
    const document = c.req.query('document');
    if (!document?.endsWith('/contracts/openapi.json')) return c.json({ error: 'Not an API document.' }, 400);
    const docs = await operationDocs(number, document, c.req.param('operation'));
    return c.json(docs, 200, { 'cache-control': 'no-store' });
  })
  // A file as committed, for the diff viewer to expand context and to diff files too large for GitHub to inline.
  .get('/raw/:sha/:path{.+}', async c => {
    const sha = c.req.param('sha');
    if (!SHA.test(sha)) return c.json({ error: 'Not a commit.' }, 400);
    const github = useGitHub();
    const text = await github.raw(sha, c.req.param('path'));
    return c.text(text, 200, { 'cache-control': 'public, max-age=31536000, immutable' });
  })
  .notFound(c => c.json({ error: 'Not found.' }, 404))
  .onError((error, c) => {
    if (error instanceof GitHubError) return c.json({ error: error.message }, error.status);
    if (error instanceof z.ZodError) return c.json({ error: 'That request was not understood.' }, 400);
    console.error(error);
    return c.json({ error: 'Something went wrong reading this pull request.' }, 500);
  });

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx)
} satisfies ExportedHandler<Env>;
