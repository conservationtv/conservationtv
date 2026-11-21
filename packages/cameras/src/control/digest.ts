import { createHash, randomBytes } from 'node:crypto';
import type { CameraCredentials } from '../settings.ts';

// HTTP requests to a camera that asks for credentials by challenge: Digest (RFC 7616, which Axis cameras ask for) or
// Basic. A request is sent bare first, and again once with the `Authorization` its challenge asks for; the challenge
// is kept, so the requests after it are answered at the first try until the camera gives a new one.

function md5(value: string): string {
  return createHash('md5').update(value).digest('hex');
}

/** A challenge's parameters: `Digest realm="AXIS", nonce="…"` as `realm` and `nonce`. */
function challengeOf(header: string): Map<string, string> {
  const parameters = new Map<string, string>();
  for (const [, name, quoted, bare] of header.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/gu))
    if (name !== undefined) parameters.set(name.toLowerCase(), quoted ?? bare ?? '');
  return parameters;
}

/** What one request is, to a challenge: its method, and its path with its query. */
interface Asked {
  method: string;
  uri: string;
}

/** Answers a camera's challenges with one set of credentials, remembering the last challenge. */
export class ChallengeAnswerer {
  private challenge: string | undefined = undefined;
  private count = 0;

  constructor(private readonly credentials: CameraCredentials | undefined) {}

  /** The `Authorization` for the request, from the challenge last seen; undefined before one, or without credentials. */
  authorization(asked: Asked): string | undefined {
    const { credentials, challenge } = this;
    if (credentials === undefined || challenge === undefined) return undefined;
    if (/^basic/iu.test(challenge)) {
      const encoded = Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64');
      return `Basic ${encoded}`;
    }
    if (!/^digest/iu.test(challenge)) return undefined;
    return this.digest(credentials, challengeOf(challenge), asked);
  }

  /** Keep the challenge a `401` carried; false when it carried none, or there are no credentials to answer with. */
  challenged(response: Response): boolean {
    const challenge = response.headers.get('www-authenticate');
    if (challenge === null || this.credentials === undefined) return false;
    this.challenge = challenge;
    this.count = 0;
    return true;
  }

  private digest(credentials: CameraCredentials, parameters: Map<string, string>, asked: Asked): string {
    const realm = parameters.get('realm') ?? '';
    const nonce = parameters.get('nonce') ?? '';
    const opaque = parameters.get('opaque');
    const first = md5(`${credentials.username}:${realm}:${credentials.password}`);
    const second = md5(`${asked.method}:${asked.uri}`);
    const fields = [
      `username="${credentials.username}"`,
      `realm="${realm}"`,
      `nonce="${nonce}"`,
      `uri="${asked.uri}"`
    ];
    // With `qop=auth` the response also covers a count of the requests answered from this nonce, and a nonce of ours.
    const qop = (parameters.get('qop') ?? '').split(',').map(option => option.trim());
    if (qop.includes('auth')) {
      this.count += 1;
      const nc = this.count.toString(16).padStart(8, '0');
      const cnonce = randomBytes(8).toString('hex');
      fields.push('qop=auth', `nc=${nc}`, `cnonce="${cnonce}"`);
      fields.push(`response="${md5(`${first}:${nonce}:${nc}:${cnonce}:auth:${second}`)}"`);
    } else {
      fields.push(`response="${md5(`${first}:${nonce}:${second}`)}"`);
    }
    if (opaque !== undefined) fields.push(`opaque="${opaque}"`);
    return `Digest ${fields.join(', ')}`;
  }
}

/** `fetch`, answering the camera's challenge once when it gives one. */
export async function fetchWithCredentials(answerer: ChallengeAnswerer, url: URL, init: RequestInit) {
  const asked = { method: init.method ?? 'GET', uri: `${url.pathname}${url.search}` };
  const send = () => {
    const headers = new Headers(init.headers);
    const authorization = answerer.authorization(asked);
    if (authorization !== undefined) headers.set('Authorization', authorization);
    return fetch(url, { ...init, headers });
  };
  const response = await send();
  if (response.status !== 401 || !answerer.challenged(response)) return response;
  // The body of the refusal is of no use, and left unread would hold its connection.
  await response.body?.cancel();
  return send();
}
