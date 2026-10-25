import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Session } from '../shared/actions.ts';
import { createGitHub, GitHubError, type GitHub } from './github.ts';
import { clearCookie, readAttempt, readSession, signInEnabled, writeCookie, type AppEnv } from './session.ts';

// Signing in with GitHub through an OAuth app that holds no permissions of its own: the reviewer grants a token that
// acts as them, on public repositories, and every change this tool makes is theirs.

/** Enough to comment, review and merge on a public repository. */
const SCOPE = 'public_repo';

const TokenSchema = z.union([
  z.object({ access_token: z.string() }),
  z.object({ error: z.string(), error_description: z.string().optional() })
]);
type Token = z.output<typeof TokenSchema>;
const GitHubUserSchema = z.object({ login: z.string(), avatar_url: z.url() });
type GitHubUser = z.output<typeof GitHubUserSchema>;

/** A path on this site to return to, never somewhere else: `//host` and `/\host` leave it. */
function returnPath(to: string | undefined): string {
  return to?.startsWith('/') && !to.startsWith('//') && !to.startsWith('/\\') ? to : '/';
}

function callbackUrl(c: Context<AppEnv>): string {
  return `${new URL(c.req.url).origin}/api/auth/callback`;
}

function random(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** The code GitHub sent back, exchanged for a token acting as whoever signed in. */
async function exchange(c: Context<AppEnv>, code: string): Promise<string> {
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: c.env.GITHUB_CLIENT_ID,
      client_secret: c.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: callbackUrl(c)
    })
  });
  const token: Token = TokenSchema.parse(await response.json());
  if ('error' in token) throw new GitHubError(400, token.error_description ?? token.error);
  return token.access_token;
}

async function whoIs(token: string): Promise<GitHubUser> {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'review.tools.conservation.tv'
    }
  });
  if (!response.ok) throw new GitHubError(502, 'GitHub would not say who signed in.');
  return GitHubUserSchema.parse(await response.json());
}

/** Gives up the token, so signing out also takes away what it could do. */
async function revoke(env: Env, token: string): Promise<void> {
  await fetch(`https://api.github.com/applications/${env.GITHUB_CLIENT_ID}/token`, {
    method: 'DELETE',
    headers: {
      authorization: `Basic ${btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`)}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'review.tools.conservation.tv'
    },
    body: JSON.stringify({ access_token: token })
  });
}

/** GitHub as the signed-in reviewer, to change something; a 401 when no one is signed in. */
export async function asReviewer(c: Context<AppEnv>): Promise<GitHub> {
  const signedIn = await readSession(c);
  if (!signedIn) throw new GitHubError(401, 'Sign in with GitHub first.');
  return createGitHub({
    repository: c.env.GITHUB_REPOSITORY,
    token: signedIn.token,
    waitUntil: promise => c.executionCtx.waitUntil(promise)
  });
}

export const auth = new Hono<AppEnv>()
  .get('/session', async c => {
    const signedIn = await readSession(c);
    const session = {
      enabled: signInEnabled(c.env),
      viewer: signedIn ? { login: signedIn.login, avatarUrl: signedIn.avatarUrl } : null
    } satisfies Session;
    return c.json(session, 200, { 'cache-control': 'no-store' });
  })
  .get('/login', async c => {
    if (!signInEnabled(c.env)) return c.json({ error: 'Signing in is not set up.' }, 404);
    const state = random();
    await writeCookie(c, 'attempt', { state, to: returnPath(c.req.query('to')) });
    const authorize = new URL('https://github.com/login/oauth/authorize');
    authorize.search = new URLSearchParams({
      client_id: c.env.GITHUB_CLIENT_ID,
      redirect_uri: callbackUrl(c),
      scope: SCOPE,
      state,
      allow_signup: 'false'
    }).toString();
    return c.redirect(authorize.toString());
  })
  .get('/callback', async c => {
    const attempt = await readAttempt(c);
    clearCookie(c, 'attempt');
    const code = c.req.query('code');
    // A state that does not match is a sign-in this browser did not start.
    if (!attempt || !code || c.req.query('state') !== attempt.state) {
      return c.json({ error: 'That sign-in was not started here, or took too long. Try again.' }, 400);
    }
    const token = await exchange(c, code);
    const user = await whoIs(token);
    await writeCookie(c, 'session', { token, login: user.login, avatarUrl: user.avatar_url });
    return c.redirect(attempt.to);
  })
  .post('/logout', async c => {
    const signedIn = await readSession(c);
    clearCookie(c, 'session');
    if (signedIn) c.executionCtx.waitUntil(revoke(c.env, signedIn.token));
    return c.body(null, 204);
  });
