import type { Principal } from '@conservationtv/umbrella';
import { user } from '@conservationtv/umbrella';
import { createMiddleware } from 'hono/factory';
import { ApiFailure } from '../errors.ts';
import { services } from '../services.ts';

/** Who the request runs as, once the session cookie has been verified. */
export type UserPrincipal = Principal<string, 'user'>;

export interface PrincipalVariables {
  principal: UserPrincipal;
}
export interface PrincipalEnv {
  Variables: PrincipalVariables;
}

/** Resolve the session (cookie, or the CLI's bearer token) to the umbrella principal; 401 without one. */
export const requirePrincipal = createMiddleware<PrincipalEnv>(async (c, next) => {
  const auth = await services().auth();
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) throw new ApiFailure('unauthenticated');
  c.set('principal', user(session.user.id));
  await next();
});
