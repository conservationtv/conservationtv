import { Hono, type Context } from 'hono';
import {
  CommentRequestSchema,
  LineCommentRequestSchema,
  AgentRequestSchema,
  CommentAgentRequestSchema,
  MergeRequestSchema,
  ResolveRequestSchema,
  ReviewRequestSchema,
  type LineComment,
  type LineSide
} from '../shared/actions.ts';
import { signoffs } from '@conservationtv/runner/signoffs';
import { asReviewer, isOperator } from './auth.ts';
import { GitHubError } from './github.ts';
import { readSession } from './session.ts';
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

const signoffNames = new Set(signoffs.map(signoff => signoff.name));

/** What the signoff agent's hook takes: the pull request, and the signoffs to run when not every one. */
interface AgentHookBody {
  pr: number;
  signoffs?: string[];
}

/** What the comment agent's hook takes: the pull request, and the comment as its github.com URL. */
interface CommentHookBody {
  pr: number;
  comment: string;
}

/** The signed-in operator, or a refusal: agents run on the owner's machine and push. */
async function operator(c: Context<AppEnv>): Promise<string> {
  const signedIn = await readSession(c);
  if (!signedIn) throw new GitHubError(401, 'Sign in with GitHub first.');
  if (!isOperator(c.env, signedIn.login)) throw new GitHubError(403, `${signedIn.login} can't start agents.`);
  return signedIn.login;
}

/** Calls an agent's hook, whose URL never leaves the Worker; 202 once it has taken the request. */
async function callHook(c: Context<AppEnv>, url: string, body: AgentHookBody | CommentHookBody): Promise<Response> {
  if (!url) return c.json({ error: 'That agent is not set up.' }, 404);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) return c.json({ error: `The agent hook answered ${response.status}.` }, 502);
  return c.body(null, 202);
}

/** Starts an agent signing a pull request off, with the signoffs named, when they are all known; else every one. */
async function startAgent(c: Context<AppEnv>, number: number): Promise<Response> {
  const input = AgentRequestSchema.parse(await c.req.json());
  await operator(c);
  const unknown = input.signoffs?.filter(name => !signoffNames.has(name)) ?? [];
  if (unknown.length) return c.json({ error: `No signoff named ${unknown.join(', ')}.` }, 400);
  const body: AgentHookBody = { pr: number };
  if (input.signoffs?.length) body.signoffs = input.signoffs;
  return callHook(c, c.env.AGENT_HOOK_URL, body);
}

/**
 * Starts an agent on one comment. Its URL is made here, from the repository, the pull request and the comment's id,
 * so the agent reads the comment from GitHub and nothing the browser sent.
 */
async function startCommentAgent(c: Context<AppEnv>, number: number, comment: number): Promise<Response> {
  const { kind } = CommentAgentRequestSchema.parse(await c.req.json());
  await operator(c);
  const anchor = kind === 'review' ? `discussion_r${comment}` : `issuecomment-${comment}`;
  const url = `https://github.com/${c.env.GITHUB_REPOSITORY}/pull/${number}#${anchor}`;
  return callHook(c, c.env.AGENT_COMMENT_HOOK_URL, { pr: number, comment: url });
}

export const actions = new Hono<AppEnv>()
  // An agent signing the pull request off on the owner's machine, through the T3 task's webhook: operators only.
  .post('/pulls/:number{[0-9]+}/agent', async c => startAgent(c, Number(c.req.param('number'))))
  // An agent fixing the code one comment points at, and replying on its thread: operators only.
  .post('/pulls/:number{[0-9]+}/comments/:comment{[0-9]+}/agent', async c =>
    startCommentAgent(c, Number(c.req.param('number')), Number(c.req.param('comment')))
  )
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
