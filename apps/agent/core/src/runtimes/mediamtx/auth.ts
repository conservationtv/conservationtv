import { createServer, type IncomingMessage, type Server } from 'node:http';
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
  private server: Server | undefined;
  private auth: MediamtxAuth | undefined;
  private keys: ReturnType<typeof createRemoteJWKSet> | undefined;

  /** @param address Where to listen, such as `127.0.0.1:9996`: loopback, since only MediaMTX asks. */
  constructor(private readonly address: string) {}

  /** Answers by `auth` from now on, listening first if it is not already. */
  async serve(auth: MediamtxAuth): Promise<void> {
    if (auth.jwks !== this.auth?.jwks) this.keys = createRemoteJWKSet(new URL(auth.jwks));
    this.auth = auth;
    if (this.server !== undefined) return;
    const server = createServer((request, response) => {
      void this.answer(request)
        .catch(() => false)
        .then(admitted => response.writeHead(admitted ? 200 : 401).end());
    });
    const { hostname, port } = new URL(`http://${this.address}`);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(Number(port), hostname.replace(/^\[|\]$/gu, ''), resolve);
    });
    this.server = server;
  }

  /** Stops answering, so MediaMTX admits no one. */
  async close(): Promise<void> {
    const { server } = this;
    this.server = undefined;
    this.auth = undefined;
    if (server !== undefined) await new Promise(resolve => server.close(resolve));
  }

  /** Whether MediaMTX should admit what it asked about; anything malformed is refused. */
  private async answer(message: IncomingMessage): Promise<boolean> {
    if (message.method !== 'POST' || message.url !== MEDIAMTX_AUTH_PATH) return false;
    const chunks: Buffer[] = [];
    for await (const chunk of message) chunks.push(Buffer.from(chunk));
    const parsed = AuthRequestSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString() || 'null'));
    if (!parsed.success) return false;
    const request = parsed.data;
    if (LOOPBACK.has(request.ip)) return true;
    return this.verify(request).catch(() => false);
  }

  /** Whether the request offers a token, signed for this gateway, admitting its action on its path. */
  private async verify(request: AuthRequest): Promise<boolean> {
    const { auth, keys } = this;
    const token = offeredToken(request);
    if (auth === undefined || keys === undefined || token === '') return false;
    const { payload } = await jwtVerify(token, keys, { issuer: auth.issuer, audience: auth.audience });
    const permissions = PermissionsSchema.safeParse(payload.mediamtx_permissions);
    return permissions.success && permits(permissions.data, request);
  }
}
