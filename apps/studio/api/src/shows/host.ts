import { DurableObject } from 'cloudflare:workers';
import { Broadcast } from '@conservationtv/shows';
import {
  compose,
  encodeStreamMessage,
  loadYoga,
  sourceStream,
  type Bootstrap,
  type LayoutEngine,
  type StreamMessage
} from '@strangecyan/vignette';
import yoga from '@strangecyan/vignette/yoga.wasm';
import { createElement } from 'react';
import type { Presentation } from './broadcast.ts';

// One organisation's broadcast (packages/shows), composed here and followed over hibernating WebSockets. Its
// composition (the state the show is composed from) belongs to the object, and changes only when it is set: setting it
// composes the show, keeps the result (what a new socket is sent first: setup, then the latest update) in storage, and
// sends what changed to every socket. Following it changes nothing: a socket is sent what was kept, and refused until
// there is something. Targets never send anything back.
//
// Two kinds of socket follow it, told apart by their tag. A member's (the studio's stage) follows the whole broadcast,
// signed in by its session. A frame page's (a clock, say, as OBS or an iframe opens it) follows only its own source,
// with no session, since such a page can't carry one: it is accepted only for a frame source the composition places,
// and sent that source alone (vignette's `sourceStream`), whose params are what the page shows anyway, never the rest of
// the show. Its source is kept on the socket, so it survives hibernation.
//
// Everything hibernates: the object keeps nothing in memory between events (no composer, no list of followers), and no
// open request keeps it awake. The sockets are the runtime's, found again by tag whenever there is something to send.

/** What the object keeps: what the broadcast was last composed from, and what that composed to. */
interface Composed {
  presentation: Presentation;
  bootstrap: Bootstrap;
}

const COMPOSED_KEY = 'composed';

/** The tags of the two kinds of socket: a member following the broadcast, and a frame page following its source. */
const MEMBER = 'member';
const FRAME = 'frame';

/** What a frame page's socket carries through hibernation: the source it follows. */
interface FrameAttachment {
  source: string;
}

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
  const { assets, serve, frameBuild } = presentation;
  const composer = compose(element, { revision, assets, serve, frameBuild, layout: engine });
  try {
    return await composer.bootstrap();
  } finally {
    composer.dispose();
  }
}

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

/** `messages` narrowed to one source, as a frame page follows it: the setup, and the update holding only that source. */
async function narrowed(messages: readonly StreamMessage[], source: string): Promise<string[]> {
  async function* batch() {
    yield* messages;
  }
  const result: string[] = [];
  for await (const message of sourceStream(batch(), source)) result.push(encodeStreamMessage(message));
  return result;
}

/** Whether the composition places a frame source with this ID: the only sources a frame page may follow. */
function placesFrame(composed: Composed, sourceId: string): boolean {
  return composed.bootstrap[1].snapshot.sources.some(source => source.id === sourceId && source.kind === 'frame');
}

function sendAll(socket: WebSocket, messages: readonly string[]): void {
  for (const message of messages) socket.send(message);
}

/** The source a frame page's socket follows, as it was accepted with. */
function frameSource(socket: WebSocket): string {
  // SAFETY: every socket tagged FRAME is accepted by `followFrame`, which attaches a FrameAttachment.
  return (socket.deserializeAttachment() as FrameAttachment).source;
}

export class ShowHost extends DurableObject<Env> {
  /**
   * Set the broadcast's composition (see `recompose`), and send what changed: members the whole of it, each frame page
   * its own source's part. Compositions are set one at a time, so revisions only go up.
   */
  async setComposition(presentation: Presentation): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      const messages = await recompose(this.ctx, presentation);
      if (messages.length === 0) return;
      const whole = messages.map(encodeStreamMessage);
      for (const socket of this.ctx.getWebSockets(MEMBER)) sendAll(socket, whole);
      // Narrowed once per source, however many pages follow it.
      const bySource = new Map<string, Promise<string[]>>();
      for (const socket of this.ctx.getWebSockets(FRAME)) {
        const source = frameSource(socket);
        let part = bySource.get(source);
        if (part === undefined) bySource.set(source, (part = narrowed(messages, source)));
        sendAll(socket, await part);
      }
    });
  }

  /** Whether the composition places the exposure; nothing does before the broadcast is composed. */
  async places(exposureId: string): Promise<boolean> {
    const composed = await this.ctx.storage.get<Composed>(COMPOSED_KEY);
    const cameras = composed?.presentation.state.cameras ?? [];
    return cameras.some(camera => camera.exposureId === exposureId);
  }

  /**
   * A WebSocket following the broadcast: a member's, or a frame page's following the source `?source=` names
   * (`…/stream`). Sent what a new socket needs, and accepted for hibernation. 404 until composed.
   */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    const url = new URL(request.url);
    const composed = await this.ctx.storage.get<Composed>(COMPOSED_KEY);
    if (url.pathname.endsWith('/stream')) return this.followFrame(composed, url.searchParams.get('source'));
    if (!composed) return new Response('The broadcast has not been composed', { status: 404 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server!, [MEMBER]);
    sendAll(server!, composed.bootstrap.map(encodeStreamMessage));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** A frame page's socket, sent its source's bootstrap: setup, then the update narrowed to it. */
  private async followFrame(composed: Composed | undefined, sourceId: string | null): Promise<Response> {
    if (!composed || sourceId === null || !placesFrame(composed, sourceId)) {
      return new Response('No such frame source', { status: 404 });
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server!, [FRAME]);
    server!.serializeAttachment({ source: sourceId } satisfies FrameAttachment);
    sendAll(server!, await narrowed(composed.bootstrap, sourceId));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Targets only listen. */
  webSocketMessage(): void {}

  /**
   * Complete the closing handshake. Always with 1000: the code a client closed with may be one only the runtime reports
   * (1005 when no code was sent, 1006 when the connection dropped), which a socket may not send.
   */
  webSocketClose(socket: WebSocket): void {
    socket.close(1000, 'Closed');
  }
}
