import { Hono } from 'hono';
import {
  CommentRequestSchema,
  LineCommentRequestSchema,
  MergeRequestSchema,
  ResolveRequestSchema,
  ReviewRequestSchema,
  type LineComment,
  type LineSide
} from '../shared/actions.ts';
import { asReviewer } from './auth.ts';
import type { AppEnv } from './session.ts';

// Changes made on GitHub as the signed-in reviewer. Each answers 204; the app then reads the pull request afresh.

const githubSides = { additions: 'RIGHT', deletions: 'LEFT' } satisfies Record<LineSide, 'RIGHT' | 'LEFT'>;

/** A line comment as GitHub's reviews API takes it: the range's end is `line`, its start `start_line`. */
function githubComment(comment: LineComment) {
  return {
    path: comment.path,
    body: comment.body,
    line: comment.line,
    side: githubSides[comment.side],
    // Left out of the JSON for a single line.
    start_line: comment.start?.line,
    start_side: comment.start ? githubSides[comment.start.side] : undefined
  };
}

const RESOLVE = `mutation ($thread: ID!) { resolveReviewThread(input: { threadId: $thread }) { thread { id } } }`;
const UNRESOLVE = `mutation ($thread: ID!) { unresolveReviewThread(input: { threadId: $thread }) { thread { id } } }`;

export const actions = new Hono<AppEnv>()
  // A thread by its GraphQL id (`PRRT_…`), as the review lists it.
  .post('/pulls/:number{[0-9]+}/threads/:thread{[A-Za-z0-9_-]+}/resolve', async c => {
    const input = ResolveRequestSchema.parse(await c.req.json());
    const github = await asReviewer(c);
    await github.mutate(input.resolved ? RESOLVE : UNRESOLVE, { thread: c.req.param('thread') });
    return c.body(null, 204);
  })
  .post('/pulls/:number{[0-9]+}/merge', async c => {
    const input = MergeRequestSchema.parse(await c.req.json());
    const github = await asReviewer(c);
    const body = { merge_method: input.method, sha: input.sha };
    await github.send('PUT', `pulls/${c.req.param('number')}/merge`, JSON.stringify(body));
    return c.body(null, 204);
  })
  .post('/pulls/:number{[0-9]+}/comments', async c => {
    const input = CommentRequestSchema.parse(await c.req.json());
    const github = await asReviewer(c);
    const body = JSON.stringify({ body: input.body });
    await github.send('POST', `issues/${c.req.param('number')}/comments`, body);
    return c.body(null, 204);
  })
  .post('/pulls/:number{[0-9]+}/comments/:comment{[0-9]+}/replies', async c => {
    const input = CommentRequestSchema.parse(await c.req.json());
    const github = await asReviewer(c);
    const path = `pulls/${c.req.param('number')}/comments/${c.req.param('comment')}/replies`;
    await github.send('POST', path, JSON.stringify({ body: input.body }));
    return c.body(null, 204);
  })
  .post('/pulls/:number{[0-9]+}/line-comments', async c => {
    const input = LineCommentRequestSchema.parse(await c.req.json());
    const github = await asReviewer(c);
    const body = { ...githubComment(input), commit_id: input.commitId };
    await github.send('POST', `pulls/${c.req.param('number')}/comments`, JSON.stringify(body));
    return c.body(null, 204);
  })
  .post('/pulls/:number{[0-9]+}/reviews', async c => {
    const input = ReviewRequestSchema.parse(await c.req.json());
    const github = await asReviewer(c);
    const body = {
      commit_id: input.commitId,
      event: input.event,
      body: input.body,
      comments: input.comments.map(githubComment)
    };
    await github.send('POST', `pulls/${c.req.param('number')}/reviews`, JSON.stringify(body));
    return c.body(null, 204);
  });
