import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';

// Who MediaMTX admits, answered by the agent itself: MediaMTX asks over HTTP (`authMethod: http`) before every read
// and publish. A reader or publisher on this machine is admitted as it is: anything running here already has the
// camera's credentials (in MediaMTX's config) and the agent's identity, so a token would add nothing. That is how the
// moq CLI publishers read renditions over RTMP, which cannot carry a token. Anyone else needs a token the studio API
// signed for this gateway, admitting that action on that path, checked as MediaMTX's own JWT method would.
//
// MediaMTX outlives the agent (runtime.ts), and admits no one while the agent is not answering.

/** Where on `authHttp` the agent answers. */
export const MEDIAMTX_AUTH_PATH = '/mediamtx/auth';

/** How tokens are checked: against the studio API's published keys, issued by it, for this gateway. */
export const MediamtxAuthSchema = z.strictObject({
  /** Where the studio API publishes the keys it signs with. */
  jwks: z.url(),
  /** The studio API, which every token names as its issuer. */
  issuer: z.string().min(1),
  /** The gateway's ID, which every token for it names as its audience. */
  audience: z.string().min(1)
});
export type MediamtxAuth = z.output<typeof MediamtxAuthSchema>;

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

/** Answers MediaMTX's authentication requests on `address`, by the tokens `auth` says how to check. */
export class MediamtxAuthServer {
  private server: ServerType | undefined;
  private auth: MediamtxAuth | undefined;
  private keys: ReturnType<typeof createRemoteJWKSet> | undefined;

  // Anything malformed is refused, as is anything asked elsewhere, which Hono answers 404.
  private readonly app = new Hono().post(MEDIAMTX_AUTH_PATH, async c => {
    const admitted = await c.req
      .json()
      .then(body => this.admits(AuthRequestSchema.parse(body)))
      .catch(() => false);
    return c.body(null, admitted ? 200 : 401);
  });

  /** @param address Where to listen, such as `127.0.0.1:9996`: loopback, since only MediaMTX asks. */
  constructor(private readonly address: string) {}

  /** Answers by `auth` from now on, listening first if it is not already. */
  async serve(auth: MediamtxAuth): Promise<void> {
    if (auth.jwks !== this.auth?.jwks) this.keys = createRemoteJWKSet(new URL(auth.jwks));
    this.auth = auth;
    if (this.server !== undefined) return;
    const { hostname, port } = new URL(`http://${this.address}`);
    this.server = await new Promise<ServerType>((resolve, reject) => {
      const options = { fetch: this.app.fetch, hostname: hostname.replace(/^\[|\]$/gu, ''), port: Number(port) };
      const server = serve(options, () => resolve(server)).once('error', reject);
    });
  }

  /** Stops answering, so MediaMTX admits no one. */
  async close(): Promise<void> {
    const { server } = this;
    this.server = undefined;
    this.auth = undefined;
    if (server !== undefined) await new Promise(resolve => server.close(resolve));
  }

  /** Whether MediaMTX should admit what it asked about: anything from this machine, or what a token admits. */
  private async admits(request: AuthRequest): Promise<boolean> {
    if (LOOPBACK.has(request.ip)) return true;
    const { auth, keys } = this;
    const token = offeredToken(request);
    if (auth === undefined || keys === undefined || token === '') return false;
    const { payload } = await jwtVerify(token, keys, { issuer: auth.issuer, audience: auth.audience });
    const permissions = PermissionsSchema.safeParse(payload.mediamtx_permissions);
    return permissions.success && permits(permissions.data, request);
  }
}
