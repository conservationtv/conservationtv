import { createStore } from '@conservationtv/store';
import type { Principal } from '@conservationtv/umbrella';
import { user } from '@conservationtv/umbrella';
import { createMiddleware } from 'hono/factory';
import { ApiFailure } from '../errors.ts';
import { useEnvironment } from '../env/env.ts';
import { requireDevice } from './device.ts';

/** Who the request runs as: a signed-in account, or a device that signed it. */
export type RequestPrincipal = Principal<string, 'user' | 'device'>;
/** A signed-in account. */
export type UserPrincipal = Principal<string, 'user'>;

const PrincipalStore = createStore<RequestPrincipal>('principal');
export const [withPrincipal, usePrincipal] = PrincipalStore;

/** The ID of the auth session the request presented: what a browser device belongs to. */
export const [withAuthSession, useAuthSession] = createStore<string>('authSession');

/** The principal, which must be a signed-in account: `forbidden` for a device. */
export function useUser(): UserPrincipal {
  const principal = usePrincipal();
  if (principal.kind !== 'user') throw new ApiFailure('forbidden');
  return user(principal.id);
}

/**
 * Resolve the request to its umbrella principal: the device that signed it, when it carries a signature
 * (`requireDevice`), and otherwise the session (cookie, or the CLI's bearer token); 401 without one. Row-level security
 * decides what either may do.
 */
export const requirePrincipal = createMiddleware(async (c, next) => {
  if (c.req.header('signature') !== undefined) return requireDevice(c, next);
  const environment = useEnvironment();
  const auth = await environment.auth();
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) throw new ApiFailure('unauthenticated');
  const principal = user(session.user.id);
  await withPrincipal(principal, () => withAuthSession(session.session.id, next));
});
