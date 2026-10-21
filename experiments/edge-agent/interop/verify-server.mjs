// Experiment: does the Rust client's device signature and request body pass what the studio API checks? A stand-in for
// the API's device operations, verifying exactly as apps/studio/api/src/middleware/device.ts does (the same libraries
// at the same versions, the same policy), and validating each body with the studio SDK's generated Zod schema.
//
//   [HOST=0.0.0.0] node interop/verify-server.mjs <hex secret key> [port]
//
// It knows one device: the key's. `GET /whoami` answers with a fixed device ID; `POST /reports` and
// `POST /iroh-sessions` are verified, validated and logged.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const sdk = new URL('../../../apps/studio/sdk/', import.meta.url);
const require = createRequire(new URL('package.json', sdk));
const { verifySignature, webcrypto } = await import(pathToFileURL(require.resolve('http-message-sig')).href);
const { verifyContentDigest } = await import(pathToFileURL(require.resolve('httpbis-digest-headers')).href);
const { PostReportsBodySchema } = await import(new URL('src/generated/zod.gen.ts', sdk).href);

const DEVICE_ID = '0199e8b2-0000-7000-8000-000000000001';
const seed = Buffer.from(process.argv[2], 'hex');
const port = Number(process.argv[3] ?? 8787);

const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
const privateKey = await crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', true, ['sign']);
const jwk = await crypto.subtle.exportKey('jwk', privateKey);
const publicId = Buffer.from(jwk.x, 'base64url').toString('hex');
const publicKey = await crypto.subtle.importKey('raw', Buffer.from(jwk.x, 'base64url'), 'Ed25519', false, ['verify']);
const nonces = new Set();

async function verify(request, body) {
  const now = Math.floor(Date.now() / 1000);
  const signature = await verifySignature(request, {
    policy: {
      algorithms: ['ed25519'],
      requiredComponents: [
        '@method',
        '@target-uri',
        'content-digest',
        ...(request.headers.has('content-type') ? ['content-type'] : [])
      ],
      requiredParameters: ['keyid', 'created', 'expires', 'nonce'],
      maxAge: 60,
      clockSkew: 5,
      now
    },
    resolveVerifier: candidate => {
      if (candidate.parameters.keyid !== publicId) throw new Error(`unknown keyid ${candidate.parameters.keyid}`);
      return webcrypto.verifier(publicKey);
    }
  });
  const digest = request.headers.get('content-digest') ?? '';
  if (digest.trim() === '' || !(await verifyContentDigest(body, digest))) throw new Error('body does not match digest');
  if (nonces.has(signature.parameters.nonce)) throw new Error('replayed nonce');
  nonces.add(signature.parameters.nonce);
}

function respond(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

createServer(async (incoming, response) => {
  const chunks = [];
  for await (const chunk of incoming) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  // The URL the client signed: this server is reached at it directly, as the API is behind no rewriting proxy.
  const url = `http://${incoming.headers.host}${incoming.url}`;
  const request = new Request(url, {
    method: incoming.method,
    headers: Object.entries(incoming.headers).flatMap(([name, value]) =>
      [value].flat().map(item => [name, item])
    ),
    body: body.length ? body : undefined
  });
  const version = incoming.headers['operation-version'];
  const log = { method: incoming.method, path: incoming.url, operationVersion: version ?? null };
  try {
    await verify(request, body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
  } catch (error) {
    console.log(JSON.stringify({ ...log, signature: 'refused', error: String(error) }));
    return respond(response, 401, { error: 'invalid_signature', message: String(error) });
  }
  log.signature = 'verified';
  if (incoming.method === 'GET' && incoming.url === '/whoami') {
    console.log(JSON.stringify(log));
    return respond(response, 200, { id: DEVICE_ID, organisationId: DEVICE_ID, kind: 'camera', publicId });
  }
  if (incoming.method === 'POST' && incoming.url === '/reports') {
    const parsed = PostReportsBodySchema.safeParse(JSON.parse(body.toString()));
    if (!parsed.success) {
      console.log(JSON.stringify({ ...log, body: 'invalid', issues: parsed.error.issues }));
      return respond(response, 400, { error: 'invalid_request', message: parsed.error.message });
    }
    console.log(JSON.stringify({ ...log, body: 'valid', reports: parsed.data.reports }));
    return respond(response, 202, { accepted: parsed.data.reports.length });
  }
  console.log(JSON.stringify({ ...log, error: 'no such route' }));
  respond(response, 404, { error: 'not_found', message: 'Not found' });
}).listen(port, process.env.HOST ?? '127.0.0.1', () => console.log(JSON.stringify({ event: 'listening', port, publicId })));
