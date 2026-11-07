import { DurableObject } from 'cloudflare:workers';
import { Broadcast } from '@conservationtv/shows';
import { compose, loadYoga, type Bootstrap, type LayoutEngine, type StreamMessage } from '@strangecyan/vignette';
import yoga from '@strangecyan/vignette/yoga.wasm';
import { createElement } from 'react';
import type { Presentation } from './broadcast.ts';

// One organisation's broadcast (packages/shows), composed here and followed by every target over a WebSocket. Its
// composition (the state the show is composed from) belongs to the object, and changes only when it is set: setting it
// composes the show, keeps the result (what a new client is sent first: setup, then the latest update) in storage, and
// sends the update to every socket. Following it changes nothing: a socket is sent what was kept, after hibernation
// included, and refused until there is something. The object keeps no composer, as hibernating would drop it.
// Targets never send anything back.

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
  const composer = compose(element, { revision, serve: presentation.serve, layout: engine });
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
 * Compose the broadcast from `presentation`, unless it already was, keep it, and send it on to every socket: the
 * update, and the setup before it when that changed. Revisions follow on from the last composition's.
 */
async function recompose(ctx: DurableObjectState, presentation: Presentation) {
  const previous = await ctx.storage.get<Composed>(COMPOSED_KEY);
  if (previous && same(previous.presentation, presentation)) return;
  const revision = (previous?.bootstrap[1].snapshot.revision ?? 0) + 1;
  const bootstrap = await composeBroadcast(presentation, revision);
  await ctx.storage.put<Composed>(COMPOSED_KEY, { presentation, bootstrap });
  const messages = changes(previous?.bootstrap, bootstrap).map(encode);
  for (const socket of ctx.getWebSockets()) sendAll(socket, messages);
}

function sendAll(socket: WebSocket, messages: readonly string[]): void {
  for (const message of messages) socket.send(message);
}

export class ShowHost extends DurableObject<Env> {
  /** Set the broadcast's composition (see `recompose`). Compositions are set one at a time, so revisions only go up. */
  async setComposition(presentation: Presentation): Promise<void> {
    await this.ctx.blockConcurrencyWhile(() => recompose(this.ctx, presentation));
  }

  /** A target following the broadcast: sent what a new client needs, and accepted for hibernation. 404 until composed. */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    const composed = await this.ctx.storage.get<Composed>(COMPOSED_KEY);
    if (!composed) return new Response('The broadcast has not been composed', { status: 404 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server!);
    sendAll(server!, composed.bootstrap.map(encode));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Targets only listen. */
  webSocketMessage(): void {}

  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    socket.close(code, reason);
  }
}
