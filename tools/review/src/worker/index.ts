import { Hono } from 'hono';
import { z } from 'zod';
import { actions } from './actions.ts';
import { auth } from './auth.ts';
import { createGitHub, GitHubError, useGitHub, withGitHub } from './github.ts';
import { operationDocs } from './operations.ts';
import { pullList, review } from './pulls.ts';
import type { AppEnv } from './session.ts';

const SHA = /^[0-9a-f]{40}$/;

const app = new Hono<AppEnv>()
  .basePath('/api')
  // Changes come only from this site's own pages: a signed-in reviewer's cookie must not carry another site's request.
  .use(async (c, next) => {
    if (c.req.method === 'GET' || c.req.header('origin') === new URL(c.req.url).origin) return next();
    return c.json({ error: 'Changes must come from this site.' }, 403);
  })
  .route('/auth', auth)
  .route('/', actions)
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
  fetch(request, env, ctx) {
    const github = createGitHub({
      repository: env.GITHUB_REPOSITORY,
      token: env.GITHUB_TOKEN ?? '',
      // Asked for straight after a change, so the change shows.
      fresh: request.headers.has('x-review-fresh'),
      waitUntil: promise => ctx.waitUntil(promise)
    });
    return withGitHub(github, () => app.fetch(request, env, ctx));
  }
} satisfies ExportedHandler<Env>;
