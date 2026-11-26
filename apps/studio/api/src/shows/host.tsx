import { DurableObject, tracing } from 'cloudflare:workers';
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
import { trustedTransaction } from '../db/transaction.ts';
import { workerEnvironment } from '../env/bindings.ts';
import { withEnvironment } from '../env/env.ts';
import { broadcastBundle, broadcastServe, type Presentation } from './broadcast.ts';
import { syncedShow } from './lineup.ts';

// One show (its broadcast, packages/shows), composed here and followed over hibernating WebSockets (docs/shows.md).
// The show's state lives in the database; what the object keeps is a cache of what it last composed (what a new
// socket is sent first: setup, then the latest update). Nobody hands it state: `sync()` takes none, and reads the show
// and its streams itself, as trusted code, normalising the lineup in a transaction that holds the show's row
// (src/shows/lineup.ts). Every sync composes afresh and compares what that composed to with what is kept, so a change
// to the composition's code counts as much as a change to its state; followers are sent only what differs.
//
// Syncs run one at a time, so later ones always see later rows and revisions only go up. They are level-triggered: a
// sync asked for while one runs is queued behind it, and every other asked for meanwhile shares that queued one, so
// none is lost and at most one waits. A sync that fails is logged and changes nothing kept; it never throws, so it
// never resets the object (which would drop every follower), and the alarm carries on as the backstop. Composing,
// storing and sending, and handing a new socket what is kept, take turns (`inTurn`), so a socket accepted while a sync
// stores a new composition is never left on the old one.
//
// What syncs it: pokes, once whatever changed has committed (src/shows/pokes.ts); the first time it is followed since
// it started, which is after every deployment, so a composition from older code is brought up to date before anyone
// is sent it; and its own alarm, a minute on while anyone follows it, which is the backstop for a missed poke and the
// only way a subject that stopped reporting is noticed, since going stale writes nothing. The object builds its own
// environment from the Worker's bindings for each sync (src/env/bindings.ts), and closes it after. A sync that finds
// the show gone closes every socket and forgets the show, so its object answers 404 from then on.
//
// Two kinds of socket follow it, told apart by their tag. A member's or an output agent's follows the whole broadcast,
// signed in by its session or signature at the route (src/routes/shows.ts). A frame page's (a clock, say, as OBS or an
// iframe opens it) follows only its own source, with no session, since such a page can't carry one: it is accepted
// only for a frame source the composition places, and sent that source alone (vignette's `sourceStream`), whose params
// are what the page shows anyway, never the rest of the show. Its source is kept on the socket, so it survives
// hibernation.
//
// Everything hibernates: the object keeps nothing in memory between events that it cannot lose (no composer, no list
// of followers), and no open request keeps it awake. The sockets are the runtime's, found again by tag whenever there
// is something to send.

/** What the object keeps: what the broadcast last composed to. */
interface Composed {
  bootstrap: Bootstrap;
}

const COMPOSED_KEY = 'composed';

/** The show's ID, kept beside it for whenever the runtime does not say which object this is. */
const SHOW_ID_KEY = 'showId';

/** How long the alarm waits to sync again, while anyone follows. */
const RESYNC_MS = 60_000;

/** The tags of the two kinds of socket: a member following the broadcast, and a frame page following its source. */
const MEMBER = 'member';
const FRAME = 'frame';

/** What a show that is gone closes its followers' sockets with: an application code, as 404 is for a request. */
const GONE_CODE = 4404;

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
  const element = <Broadcast state={presentation.state} />;
  const { assets, serve, frameBuild } = presentation;
  const composer = compose(element, { revision, assets, serve, frameBuild, layout: engine });
  try {
    return await composer.bootstrap();
  } finally {
    composer.dispose();
  }
}

/** Whether two plain values are the same data. */
function same<Value>(left: Value, right: Value) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Whether two compositions show the same: the same setup, and the same snapshot but for its revision, which every
 * composition counts on. vignette's composer is deterministic (its IDs are the show's own), so this holds exactly
 * when nothing a target would see has changed.
 */
function sameComposition([leftSetup, leftUpdate]: Bootstrap, [rightSetup, rightUpdate]: Bootstrap) {
  if (!same(leftSetup, rightSetup)) return false;
  return same({ ...leftUpdate.snapshot, revision: 0 }, { ...rightUpdate.snapshot, revision: 0 });
}

/**
 * What a socket already following `previous` is sent for `next`: the update, after the setup if that changed. A setup
 * is the show's identity and where things are served, so in practice it is sent once.
 */
function changes(previous: Bootstrap | undefined, next: Bootstrap): StreamMessage[] {
  const [setup, update] = next;
  return previous && same(previous[0], setup) ? [update] : [setup, update];
}

/**
 * Compose the broadcast from `presentation` and keep it, unless it composes to what is kept already. Returns what each
 * follower is sent: the update, and the setup before it when that changed; nothing when nothing did. Revisions follow
 * on from the kept composition's.
 */
async function recompose(ctx: DurableObjectState, presentation: Presentation): Promise<StreamMessage[]> {
  const previous = await ctx.storage.get<Composed>(COMPOSED_KEY);
  const revision = (previous?.bootstrap[1].snapshot.revision ?? 0) + 1;
  const bootstrap = await composeBroadcast(presentation, revision);
  if (previous && sameComposition(previous.bootstrap, bootstrap)) return [];
  await ctx.storage.put<Composed>(COMPOSED_KEY, { bootstrap });
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
  /** The sync running now, and the one queued behind it, which every sync asked for meanwhile shares. */
  private running: Promise<void> | undefined = undefined;
  private queued: Promise<void> | undefined = undefined;

  /** Whether a sync has succeeded since this instance started: until one has, what is kept may be older code's. */
  private current = false;

  /** The last step to take its turn (`inTurn`). */
  private turn: Promise<unknown> = Promise.resolve();

  /**
   * Look again (see the top of this file): read the show, compose it, and send what changed: members the whole of it,
   * each frame page its own source's part. Never throws: a failure is logged, and the alarm tries again.
   */
  sync(): Promise<void> {
    if (this.queued !== undefined) return this.queued;
    if (this.running === undefined) return this.start();
    const queued = this.running.then(() => {
      this.queued = undefined;
      return this.start();
    });
    this.queued = queued;
    return queued;
  }

  /** The alarm: sync again while anyone follows, and come back a minute on; stop once no one does. */
  async alarm(): Promise<void> {
    if (this.ctx.getWebSockets().length === 0) return;
    await this.sync();
    if (this.ctx.getWebSockets().length === 0) return;
    await this.ctx.storage.setAlarm(Date.now() + RESYNC_MS);
  }

  /**
   * A WebSocket following the broadcast: a member's or an agent's, or a frame page's following the source `?source=`
   * names (`…/stream`). The first follow since the object started syncs first, so nobody is sent a composition older
   * code made, and a member following a show never composed has it composed. Sent what a new socket needs, and accepted for hibernation; 404 while nothing is composed, as for a show
   * that is gone.
   */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    const url = new URL(request.url);
    const frame = url.pathname.endsWith('/stream');
    // A frame page's route has no session, so it syncs only what was composed before: a show its object never
    // composed, or forgot, is refused without reading the database for whoever asks.
    if (!this.current && (!frame || (await this.ctx.storage.get(COMPOSED_KEY)) !== undefined)) await this.sync();
    const response = frame
      ? await this.inTurn(() => this.followFrame(url.searchParams.get('source')))
      : await this.inTurn(() => this.followMember());
    if (response.status !== 101) return response;
    try {
      await this.keepSyncing();
    } catch (error) {
      console.warn(JSON.stringify({ event: 'show_alarm_failed', showId: this.ctx.id.name, cause: String(error) }));
    }
    return response;
  }

  /** A member's or agent's socket, sent the bootstrap: setup, then the latest update. */
  private async followMember(): Promise<Response> {
    const composed = await this.ctx.storage.get<Composed>(COMPOSED_KEY);
    if (!composed) return new Response('The show is not there', { status: 404 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server!, [MEMBER]);
    sendAll(server!, composed.bootstrap.map(encodeStreamMessage));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** A frame page's socket, sent its source's bootstrap: setup, then the update narrowed to it. */
  private async followFrame(sourceId: string | null): Promise<Response> {
    const composed = await this.ctx.storage.get<Composed>(COMPOSED_KEY);
    if (!composed || sourceId === null || !placesFrame(composed, sourceId)) {
      return new Response('No such frame source', { status: 404 });
    }
    const messages = await narrowed(composed.bootstrap, sourceId);
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server!, [FRAME]);
    server!.serializeAttachment({ source: sourceId } satisfies FrameAttachment);
    sendAll(server!, messages);
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

  /** Run a sync now, as the one running. */
  private start(): Promise<void> {
    const run = this.syncOnce().finally(() => {
      if (this.running === run) this.running = undefined;
    });
    this.running = run;
    return run;
  }

  /** One sync, start to end: never throws. */
  private async syncOnce(): Promise<void> {
    let showId: string | undefined = undefined;
    try {
      showId = await this.showId();
      const presentation = await this.present(showId);
      if (presentation === undefined) {
        await this.inTurn(() => this.forget());
        return;
      }
      await this.inTurn(async () => this.send(await recompose(this.ctx, presentation)));
      this.current = true;
    } catch (error) {
      console.warn(JSON.stringify({ event: 'show_sync_failed', showId, cause: String(error) }));
    }
    try {
      await this.keepSyncing();
    } catch (error) {
      console.warn(JSON.stringify({ event: 'show_alarm_failed', showId, cause: String(error) }));
    }
  }

  /** Run `step` once every step before it has finished, and before any after it starts. */
  private inTurn<Result>(step: () => Promise<Result>): Promise<Result> {
    const result = this.turn.then(step);
    this.turn = result.catch(() => undefined);
    return result;
  }

  /**
   * What the show is composed from now, read in an environment of the object's own: its state, resolved after
   * normalising its lineup, the bundle and where it is served. None for a show that is gone; throws when it cannot be
   * read.
   */
  private async present(showId: string | undefined): Promise<Presentation | undefined> {
    if (showId === undefined) return undefined;
    const { exports } = this.ctx;
    const context = { exports, waitUntil: (task: Promise<unknown>) => this.ctx.waitUntil(task), tracing };
    const { environment, close } = workerEnvironment(this.env, context);
    try {
      return await withEnvironment(environment, async () => {
        const synced = await trustedTransaction(() => syncedShow({ showId }), { name: 'show.sync' });
        if (synced === undefined) return undefined;
        const apiUrl = environment.variables.APP_URL;
        const bundle = await broadcastBundle(environment.assets, apiUrl);
        const serve = broadcastServe(synced.organisationId, showId, apiUrl);
        return { state: synced.state, ...bundle, serve };
      });
    } finally {
      await close();
    }
  }

  /** Send what changed: members the whole of it, each frame page its own source's part, narrowed once per source. */
  private async send(messages: readonly StreamMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const whole = messages.map(encodeStreamMessage);
    for (const socket of this.ctx.getWebSockets(MEMBER)) sendAll(socket, whole);
    const bySource = new Map<string, Promise<string[]>>();
    for (const socket of this.ctx.getWebSockets(FRAME)) {
      const source = frameSource(socket);
      let part = bySource.get(source);
      if (part === undefined) bySource.set(source, (part = narrowed(messages, source)));
      sendAll(socket, await part);
    }
  }

  /**
   * The show is gone: tell every follower so, and forget it, alarm and all, so the object answers 404 and stops waking.
   * Its sockets' clients may ask again; they are refused.
   */
  private async forget(): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) socket.close(GONE_CODE, 'The show is gone');
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.current = false;
  }

  /**
   * Make sure the alarm will sync again while anyone follows. Never postpones one already set, so following again and
   * again cannot hold the backstop off.
   */
  private async keepSyncing(): Promise<void> {
    if (this.ctx.getWebSockets().length === 0) return;
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null) await this.ctx.storage.setAlarm(Date.now() + RESYNC_MS);
  }

  /**
   * Which show this object is: the name it was reached by, kept so it is known when the runtime does not say, as in an
   * alarm it may not.
   */
  private async showId(): Promise<string | undefined> {
    const name = this.ctx.id.name;
    if (name === undefined) return this.ctx.storage.get<string>(SHOW_ID_KEY);
    const kept = await this.ctx.storage.get<string>(SHOW_ID_KEY);
    if (kept !== name) await this.ctx.storage.put(SHOW_ID_KEY, name);
    return name;
  }
}
