import { Hono } from 'hono';
import { createGitHub, GitHubError, useGitHub, withGitHub } from './github.ts';
import { pullList, review } from './pulls.ts';

const SHA = /^[0-9a-f]{40}$/;

const app = new Hono()
  .basePath('/api')
  .get('/pulls', async c => c.json(await pullList(), 200, { 'cache-control': 'no-store' }))
  .get('/pulls/:number{[0-9]+}', async c => {
    const number = Number(c.req.param('number'));
    return c.json(await review(number), 200, { 'cache-control': 'no-store' });
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
    console.error(error);
    return c.json({ error: 'Something went wrong reading this pull request.' }, 500);
  });

export default {
  fetch(request, env, ctx) {
    const github = createGitHub({
      repository: env.GITHUB_REPOSITORY,
      token: env.GITHUB_TOKEN ?? '',
      waitUntil: promise => ctx.waitUntil(promise)
    });
    return withGitHub(github, () => app.fetch(request));
  }
} satisfies ExportedHandler<Env>;
