import type { DeviceIdentity, MediamtxAuth } from '@conservationtv/studio-sdk';
import { serve, type ServerType } from '@hono/node-server';
import { sValidator } from '@hono/standard-validator';
import { Hono } from 'hono';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';

// Who MediaMTX admits, answered by the agent itself: MediaMTX asks over HTTP (`authMethod: http`) before every read
// and publish. A reader or publisher on this machine is admitted as it is: anything running here already has the
// camera's credentials (in MediaMTX's config) and the agent's identity, so a token would add nothing. That is how the
// moq CLI publishers read renditions over RTMP, which cannot carry a token. Anyone else needs a token the studio API
// signed for this gateway with the agent's own identity, admitting that action on that path, checked as MediaMTX's
// own JWT method would against the agent's public key: the agent holds it, so nothing is fetched from anywhere. It
// serves that key as a JWKS beside the answers, for a MediaMTX that checks tokens itself (`authJWTJWKS`).
//
// MediaMTX lives and dies with the agent (runtime.ts), so it is never running without these answers.

/** Where on `authHttp` the agent answers. */
export const MEDIAMTX_AUTH_PATH = '/mediamtx/auth';

/** Where on `authHttp` the agent serves the JWKS of its identity. */
export const MEDIAMTX_JWKS_PATH = '/mediamtx/jwks';

/** What MediaMTX asks about: who is doing what, to which path, and whatever credentials they offered. */
const AuthRequestSchema = z.object({
  ip: z.string(),
  action: z.string(),
  path: z.string().default(''),
  password: z.string().default(''),
  token: z.string().default(''),
  query: z.string().default('')
});
type AuthRequest = z.output<typeof AuthRequestSchema>;

/** What a token admits, as MediaMTX's JWT method reads it: an empty path is any path. */
const PermissionsSchema = z.array(z.object({ action: z.string(), path: z.string().default('') }));
type Permissions = z.output<typeof PermissionsSchema>;

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** The token offered: as a bearer token or the password, or in the URL's query, as `jwt` or `token`. */
function offeredToken(request: AuthRequest) {
  const query = new URLSearchParams(request.query);
  const token = request.token || request.password || query.get('jwt') || query.get('token');
  return token ?? '';
}

function permits(permissions: Permissions, request: AuthRequest) {
  return permissions.some(({ action, path }) => action === request.action && (path === '' || path === request.path));
}

type JwksKeys = ReturnType<typeof createLocalJWKSet>;

/** Whether MediaMTX should admit what it asked about: anything from this machine, or what a token admits. */
async function admits(request: AuthRequest, auth: MediamtxAuth, keys: JwksKeys): Promise<boolean> {
  if (LOOPBACK.has(request.ip)) return true;
  const token = offeredToken(request);
  if (token === '') return false;
  const { payload } = await jwtVerify(token, keys, { issuer: auth.issuer, audience: auth.audience });
  const permissions = PermissionsSchema.safeParse(payload.mediamtx_permissions);
  return permissions.success && permits(permissions.data, request);
}

/**
 * Answers MediaMTX's authentication requests by tokens signed as `identity`, issued and scoped as `auth` says, and
 * serves `identity`'s JWKS. Anything malformed or failing is refused, as is anything asked elsewhere, which Hono
 * answers 404.
 */
export function createMediamtxAuthApp(auth: MediamtxAuth, identity: DeviceIdentity): Hono {
  const jwks = { keys: [identity.publicJwk] };
  const keys = createLocalJWKSet(jwks);
  const app = new Hono()
    .get(MEDIAMTX_JWKS_PATH, c => c.json(jwks))
    .post(
      MEDIAMTX_AUTH_PATH,
      sValidator('json', AuthRequestSchema, (result, c) => {
        if (!result.success) return c.body(null, 401);
      }),
      async c => {
        const admitted = await admits(c.req.valid('json'), auth, keys);
        return c.body(null, admitted ? 200 : 401);
      }
    )
    .onError((_error, c) => c.body(null, 401));
  return app;
}

/**
 * Serves `app` on `address` (such as `127.0.0.1:9996`: loopback, since only MediaMTX asks) until the returned function
 * closes it, after which MediaMTX admits no one.
 */
export async function serveMediamtxAuth(address: string, app: Hono): Promise<() => Promise<void>> {
  const { hostname, port } = new URL(`http://${address}`);
  const server = await new Promise<ServerType>((resolve, reject) => {
    const options = { fetch: app.fetch, hostname: hostname.replace(/^\[|\]$/gu, ''), port: Number(port) };
    const listening = serve(options, () => resolve(listening)).once('error', reject);
  });
  return () => new Promise(resolve => server.close(() => resolve()));
}
