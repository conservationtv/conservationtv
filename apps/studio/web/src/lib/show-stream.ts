import { createAsyncQueue, StreamMessageSchema, type StreamMessage } from '@strangecyan/vignette';

import { API_URL } from './auth-client';

// An organisation's broadcast as a vignette stream: the studio API's show object (apps/studio/api/src/shows/host.ts)
// sends one JSON stream message per WebSocket frame, the bootstrap (setup, then the latest update) first on every
// connection. That replay is all a reconnect needs, so a dropped socket is simply dialled again, with backoff. The
// session cookie travels with the upgrade, as with every call to the API.

/** The first wait before redialling, doubled per failure up to the most. */
const INITIAL_DELAY_MS = 500;
const MAXIMUM_DELAY_MS = 10_000;

/** Where to follow the organisation's broadcast: the API's address, as a WebSocket. */
function broadcastUrl(organisationId: string) {
  const url = new URL(`/organisations/${organisationId}/show`, API_URL);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url;
}

/**
 * The organisation's broadcast, for `<Stream source>`. Each iteration opens its own socket, so the same value can be
 * followed again (as a remount does); stopping iteration closes it.
 */
export function broadcastStream(organisationId: string): AsyncIterable<StreamMessage> {
  const url = broadcastUrl(organisationId);
  return {
    [Symbol.asyncIterator]: () => {
      const stop = new AbortController();
      const messages = follow(url, stop.signal);
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

/** Every message from `url`, redialling whenever the socket closes, until `signal` aborts. */
async function* follow(url: URL, signal: AbortSignal): AsyncGenerator<StreamMessage> {
  let attempt = 0;
  while (!signal.aborted) {
    let delivered = false;
    for await (const message of connection(url, signal)) {
      delivered = true;
      yield message;
    }
    attempt = delivered ? 1 : attempt + 1;
    await sleep(Math.min(INITIAL_DELAY_MS * 2 ** (attempt - 1), MAXIMUM_DELAY_MS), signal);
  }
}

/** One socket's messages, ending when it closes or `signal` aborts. A frame that is not a stream message ends it. */
async function* connection(url: URL, signal: AbortSignal): AsyncGenerator<StreamMessage> {
  const queue = createAsyncQueue<StreamMessage>();
  const socket = new WebSocket(url);
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

/** Resolves after `ms`, or as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>(resolve => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
