import { createHash } from 'node:crypto';
import { connect as connectTcp, type Socket } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { z } from 'zod';

// Asking a camera's RTSP server to describe a stream (`DESCRIBE`), which is all a probe needs: the camera answers with
// what it would send, without sending any of it, so nothing is encoded or pulled. Answers a challenge for credentials
// once, by Digest (which Axis cameras ask for) or Basic, with those in the URL.

const DEFAULT_PORT = 554;

/** What a camera said, or why it said nothing. */
export type Described = Answered | Unanswered;
interface Answered {
  ok: true;
  /** How long it took to answer, in seconds. */
  seconds: number;
}
interface Unanswered {
  ok: false;
  /** Why, in a few words: `connection refused`, `timed out`, `401 Unauthorized`. */
  reason: string;
}

/** One RTSP response's status and headers: a `DESCRIBE`'s body isn't read. */
interface Response {
  status: number;
  text: string;
  headers: Map<string, string>;
}

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

/** The `Authorization` a challenge asks for, with the URL's credentials; undefined for a scheme that isn't known. */
function authorization(challenge: string, url: URL, uri: string): string | undefined {
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (/^basic/iu.test(challenge)) {
    const encoded = Buffer.from(`${username}:${password}`).toString('base64');
    return `Basic ${encoded}`;
  }
  if (!/^digest/iu.test(challenge)) return undefined;
  const parameters = challengeOf(challenge);
  const realm = parameters.get('realm') ?? '';
  const nonce = parameters.get('nonce') ?? '';
  const response = md5(`${md5(`${username}:${realm}:${password}`)}:${nonce}:${md5(`DESCRIBE:${uri}`)}`);
  return `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
}

/** A response's status line and headers, from everything before the blank line that ends them. */
function parseResponse(head: string): Response | undefined {
  const [statusLine = '', ...lines] = head.split('\r\n');
  const [, status, text = ''] = /^RTSP\/\d\.\d (\d{3}) ?(.*)$/u.exec(statusLine) ?? [];
  if (status === undefined) return undefined;
  const headers = new Map<string, string>();
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { status: Number(status), text, headers };
}

/** The first response on the socket: its status line and headers, read up to the blank line that ends them. */
function readResponse(socket: Socket): Promise<Response> {
  return new Promise((resolve, reject) => {
    let received = '';
    const done = (settle: () => void) => {
      socket.off('data', onData);
      socket.off('error', reject);
      socket.off('close', onClose);
      settle();
    };
    const onClose = () => done(() => reject(new Error('connection closed')));
    const onData = (chunk: Buffer) => {
      // Keep reading until the headers have ended; then it is a response, or this isn't an RTSP server.
      received += chunk.toString('latin1');
      const end = received.indexOf('\r\n\r\n');
      if (end === -1) return;
      const response = parseResponse(received.slice(0, end));
      if (response === undefined) done(() => reject(new Error('not an RTSP server')));
      else done(() => resolve(response));
    };
    socket.on('data', onData);
    socket.once('error', reject);
    socket.once('close', onClose);
  });
}

/** Send a `DESCRIBE` of `uri`, and read what the server says to it. */
function request(socket: Socket, uri: string, sequence: number, authorized: string | undefined): Promise<Response> {
  const lines = [`DESCRIBE ${uri} RTSP/1.0`, `CSeq: ${sequence}`, 'Accept: application/sdp'];
  if (authorized !== undefined) lines.push(`Authorization: ${authorized}`);
  const answer = readResponse(socket);
  socket.write(`${lines.join('\r\n')}\r\n\r\n`);
  return answer;
}

/** What a failed connection says of itself: Node's error code, when it is one of its own. */
const FailureSchema = z.object({ name: z.string(), message: z.string(), code: z.string().optional() });
type Failure = z.output<typeof FailureSchema>;

const FAILURE_REASONS = new Map([
  ['ECONNREFUSED', 'connection refused'],
  ['EHOSTUNREACH', 'no route to it'],
  ['ENETUNREACH', 'no route to it'],
  ['ENOTFOUND', 'its hostname does not resolve'],
  ['ECONNRESET', 'connection reset']
]);

/** Why a probe failed, in a few words. */
function reasonOf({ name, message, code }: Failure): string {
  if (name === 'AbortError' || name === 'TimeoutError') return 'timed out';
  return FAILURE_REASONS.get(code ?? '') ?? message;
}

/** Ask for the description, answering a challenge for credentials once when the URL has them. */
async function describe(socket: Socket, target: URL, uri: string): Promise<Response> {
  const response = await request(socket, uri, 1, undefined);
  const challenge = response.headers.get('www-authenticate');
  if (response.status !== 401 || challenge === undefined || target.username === '') return response;
  const authorized = authorization(challenge, target, uri);
  return authorized === undefined ? response : request(socket, uri, 2, authorized);
}

/**
 * Ask the camera at `url` (`rtsp://` or `rtsps://`, credentials included) to describe its stream, giving up at
 * `signal`. It is there when it answers with a description; anything else says why not.
 */
export async function describeStream(url: string, signal: AbortSignal): Promise<Described> {
  const target = new URL(url);
  const port = target.port === '' ? DEFAULT_PORT : Number(target.port);
  // What the camera is asked for is the URL without its credentials, which go in the `Authorization` header.
  const uri = `${target.protocol}//${target.host}${target.pathname}${target.search}`;
  const startedAt = performance.now();
  const options = { host: target.hostname, port, signal };
  const socket =
    target.protocol === 'rtsps:' ? connectTls({ ...options, servername: target.hostname }) : connectTcp(options);
  try {
    const response = await describe(socket, target, uri);
    if (response.status !== 200) return { ok: false, reason: `${response.status} ${response.text}`.trim() };
    return { ok: true, seconds: (performance.now() - startedAt) / 1000 };
  } catch (error) {
    // Giving up closes the socket, which fails whatever read was waiting on it: that is the timeout, not its cause.
    if (signal.aborted) return { ok: false, reason: 'timed out' };
    const failure = FailureSchema.safeParse(error);
    return { ok: false, reason: failure.success ? reasonOf(failure.data) : String(error) };
  } finally {
    socket.destroy();
  }
}
