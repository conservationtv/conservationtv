import { createStore } from '@conservationtv/store';
import type { Principal } from '@conservationtv/umbrella';
import { user } from '@conservationtv/umbrella';
import { createMiddleware } from 'hono/factory';
import { ApiFailure } from '../errors.ts';
import { useServices } from '../services.ts';

/** Who the request runs as, once the session cookie has been verified. */
export type UserPrincipal = Principal<string, 'user'>;

const PrincipalStore = createStore<UserPrincipal>('principal');
export const [withPrincipal, usePrincipal] = PrincipalStore;

/** The ID of the auth session the request presented: what a browser device belongs to. */
export const [withAuthSession, useAuthSession] = createStore<string>('authSession');

/** Resolve the session (cookie, or the CLI's bearer token) to the umbrella principal; 401 without one. */
export const requirePrincipal = createMiddleware(async (c, next) => {
  const services = useServices();
  const auth = await services.auth();
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) throw new ApiFailure('unauthenticated');
  const principal = user(session.user.id);
  await withPrincipal(principal, () => withAuthSession(session.session.id, next));
});
