import { setTimeout as sleep } from 'node:timers/promises';
import type { DeviceIdentity } from '@conservationtv/studio-sdk';
import { getLogger } from '@logtape/logtape';
import { createAsyncQueue, StreamMessageSchema, type StreamMessage } from '@strangecyan/vignette';

// The show an OBS output follows, as a vignette stream: the studio API's show object (apps/studio/api/src/shows)
// sends one JSON stream message per WebSocket frame, the bootstrap (setup, then the latest update) first on every
// connection, which is all a reconnect needs. Each upgrade is signed as the agent's device, as every call to the
// studio API is; the API refuses it (404) until the show has been composed, and then this keeps dialling, with backoff.

const logger = getLogger(['agent', 'obs', 'show']);

/** Node's WebSocket constructor, undici's: as well as protocols, it takes headers for the upgrade, as the DOM's doesn't. */
interface NodeWebSocketConstructor {
  new (url: URL, init?: string | string[] | UpgradeInit): WebSocket;
}

/** What an upgrade is sent with: the signed request's headers. */
interface UpgradeInit {
  headers: Record<string, string>;
}

// SAFETY: in Node the global WebSocket is undici's, whose constructor takes a `WebSocketInit` with `headers`; the DOM
// library this project also types against declares it without.
const NodeWebSocket = WebSocket as NodeWebSocketConstructor;

/** The first wait before redialling, doubled per failure up to the most. */
const INITIAL_DELAY_MS = 500;
const MAXIMUM_DELAY_MS = 10_000;

/**
 * The show at `url` (its `https:` or `http:` address, as the configuration gives it), for a target to follow. Each
 * iteration opens its own socket; stopping iteration closes it.
 */
export function showStream(url: string, identity: DeviceIdentity): AsyncIterable<StreamMessage> {
  return {
    [Symbol.asyncIterator]: () => {
      const stop = new AbortController();
      const messages = follow(url, identity, stop.signal);
      return {
        next: () => messages.next(),
        return: () => {
          stop.abort();
          return messages.return(undefined);
        }
      };
    }
  };
}

/**
 * Every message from the show, redialling whenever the socket closes, until `signal` aborts. The wait before each
 * redial doubles while connections deliver nothing (a show not composed yet is refused), and starts over once one does.
 */
async function* follow(url: string, identity: DeviceIdentity, signal: AbortSignal): AsyncGenerator<StreamMessage> {
  let attempt = 0;
  while (!signal.aborted) {
    // One connection: pass its messages on; then, unless stopping, wait longer the more connections in a row failed.
    let delivered = false;
    try {
      for await (const message of connection(url, identity, signal)) {
        delivered = true;
        yield message;
      }
    } catch (error) {
      if (signal.aborted) return;
      logger.warn('Following the show failed: {error}', { error });
    }
    attempt = delivered ? 1 : attempt + 1;
    const delay = Math.min(INITIAL_DELAY_MS * 2 ** (attempt - 1), MAXIMUM_DELAY_MS);
    await sleep(delay, undefined, { signal }).catch(() => undefined);
  }
}

/** The headers of a signed upgrade to `url`: the device's signature over a `GET` with an empty body. */
async function signedHeaders(url: string, identity: DeviceIdentity): Promise<Record<string, string>> {
  const signed = await identity.sign(new Request(url));
  return Object.fromEntries(signed.headers);
}

/** `url` as the WebSocket it is dialled as. */
function socketUrl(url: string): URL {
  const socket = new URL(url);
  socket.protocol = socket.protocol === 'https:' ? 'wss:' : 'ws:';
  return socket;
}

/** One socket's messages, ending when it closes or `signal` aborts. A frame that is not a stream message ends it. */
async function* connection(url: string, identity: DeviceIdentity, signal: AbortSignal): AsyncGenerator<StreamMessage> {
  const headers = await signedHeaders(url, identity);
  const queue = createAsyncQueue<StreamMessage>();
  const socket = new NodeWebSocket(socketUrl(url), { headers });
  const close = () => socket.close();
  socket.addEventListener('message', event => {
    const parsed = StreamMessageSchema.safeParse(JSON.parse(String(event.data)));
    if (parsed.success) queue.push(parsed.data);
    else queue.fail(parsed.error);
  });
  socket.addEventListener('close', () => queue.close());
  signal.addEventListener('abort', close, { once: true });
  try {
    yield* queue;
  } finally {
    signal.removeEventListener('abort', close);
    close();
  }
}
