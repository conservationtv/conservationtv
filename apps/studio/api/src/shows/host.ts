import { DurableObject } from 'cloudflare:workers';
import { Broadcast } from '@conservationtv/shows';
import {
  compose,
  createAsyncQueue,
  encodeStreamMessageSse,
  loadYoga,
  sourceStream,
  type AsyncQueue,
  type Bootstrap,
  type LayoutEngine,
  type StreamMessage
} from '@strangecyan/vignette';
import yoga from '@strangecyan/vignette/yoga.wasm';
import { createElement } from 'react';
import type { Presentation } from './broadcast.ts';

// One organisation's broadcast (packages/shows), composed here and followed by every target over a WebSocket. Its
// composition (the state the show is composed from) belongs to the object, and changes only when it is set: setting it
// composes the show, keeps the result (what a new client is sent first: setup, then the latest update) in storage, and
// sends the update to every socket. Following it changes nothing: a socket is sent what was kept, after hibernation
// included, and refused until there is something. The object keeps no composer, as hibernating would drop it.
// Targets never send anything back.
//
// A frame page (a clock, say) follows only its own source, by server-sent events: it is a page OBS or an iframe
// opens, which can't sign or carry a session, so this is the one way in that is open. It serves frame sources only,
// whose params are what the page shows anyway, never the rest of the show. An open stream keeps the object awake, as
// any request does.

/** What the object keeps: what the broadcast was last composed from, and what that composed to. */
interface Composed {
  presentation: Presentation;
  bootstrap: Bootstrap;
}

const COMPOSED_KEY = 'composed';

/** Yoga, compiled once per isolate: Workers cannot compile wasm at runtime, so it is imported as a module. */
let layout: Promise<LayoutEngine> | undefined = undefined;

function layoutEngine() {
  if (layout === undefined) layout = loadYoga(yoga);
  return layout;
}

/** The broadcast composed from `presentation`, its first snapshot at `revision`. */
async function composeBroadcast(presentation: Presentation, revision: number): Promise<Bootstrap> {
  const engine = await layoutEngine();
  const element = createElement(Broadcast, { state: presentation.state });
  const { assets, serve } = presentation;
  const composer = compose(element, { revision, assets, serve, layout: engine });
  try {
    return await composer.bootstrap();
  } finally {
    composer.dispose();
  }
}

/** A stream message as a socket carries it: one JSON text frame each. */
const encode = (message: StreamMessage) => JSON.stringify(message);

/** Whether two plain values are the same data. */
const same = <Value>(left: Value, right: Value) => JSON.stringify(left) === JSON.stringify(right);

/**
 * What a socket already following `previous` is sent for `next`: the update, after the setup if that changed. A setup
 * is the show's identity and where things are served, so in practice it is sent once.
 */
function changes(previous: Bootstrap | undefined, next: Bootstrap): StreamMessage[] {
  const [setup, update] = next;
  return previous && same(previous[0], setup) ? [update] : [setup, update];
}

/**
 * Compose the broadcast from `presentation`, unless it already was, and keep it. Returns what each follower is sent: the
 * update, and the setup before it when that changed; nothing when it was already composed. Revisions follow on from
 * the last composition's.
 */
async function recompose(ctx: DurableObjectState, presentation: Presentation): Promise<StreamMessage[]> {
  const previous = await ctx.storage.get<Composed>(COMPOSED_KEY);
  if (previous && same(previous.presentation, presentation)) return [];
  const revision = (previous?.bootstrap[1].snapshot.revision ?? 0) + 1;
  const bootstrap = await composeBroadcast(presentation, revision);
  await ctx.storage.put<Composed>(COMPOSED_KEY, { presentation, bootstrap });
  return changes(previous?.bootstrap, bootstrap);
}

function sendAll(socket: WebSocket, messages: readonly string[]): void {
  for (const message of messages) socket.send(message);
}

/** Whether the composition places a frame source with this ID: the only sources a frame page may follow. */
function placesFrame(composed: Composed, sourceId: string): boolean {
  return composed.bootstrap[1].snapshot.sources.some(source => source.id === sourceId && source.kind === 'frame');
}

/** `messages` as a body of server-sent events; `closed` runs when the page goes. */
function serverSentEvents(messages: AsyncIterable<StreamMessage>, closed: () => void): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const iterator = messages[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(encoder.encode(encodeStreamMessageSse(next.value)));
    },
    async cancel() {
      closed();
      await iterator.return?.();
    }
  });
}

export class ShowHost extends DurableObject<Env> {
  /** The frame pages following their sources now: kept in memory, as each is an open request. */
  private readonly frames = new Set<AsyncQueue<StreamMessage>>();

  /** Set the broadcast's composition (see `recompose`). Compositions are set one at a time, so revisions only go up. */
  async setComposition(presentation: Presentation): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const messages = await recompose(this.ctx, presentation);
      const frames = messages.map(encode);
      for (const socket of this.ctx.getWebSockets()) sendAll(socket, frames);
      for (const queue of this.frames) for (const message of messages) queue.push(message);
    });
  }

  /** A target following the broadcast by WebSocket, or a frame page its source by server-sent events. */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/stream')) return this.frameStream(url);
    return this.follow(request);
  }

  /** A socket following the broadcast: sent what a new client needs, and accepted for hibernation. 404 until composed. */
  private async follow(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    const composed = await this.ctx.storage.get<Composed>(COMPOSED_KEY);
    if (!composed) return new Response('The broadcast has not been composed', { status: 404 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server!);
    sendAll(server!, composed.bootstrap.map(encode));
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * The stream of the frame source `?source=` names, as vignette's frame page follows it: its bootstrap, then each
   * change to that source. 404 for anything but a frame source the composition places.
   */
  private async frameStream(url: URL): Promise<Response> {
    const sourceId = url.searchParams.get('source');
    const composed = await this.ctx.storage.get<Composed>(COMPOSED_KEY);
    if (!composed || sourceId === null || !placesFrame(composed, sourceId)) {
      return new Response('No such frame source', { status: 404 });
    }
    const queue = createAsyncQueue<StreamMessage>();
    for (const message of composed.bootstrap) queue.push(message);
    this.frames.add(queue);
    const body = serverSentEvents(sourceStream(queue, sourceId), () => {
      this.frames.delete(queue);
      queue.close();
    });
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } });
  }

  /** Targets only listen. */
  webSocketMessage(): void {}

  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    socket.close(code, reason);
  }
}
