import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AttachedProcess, type Run } from '@conservationtv/converge/process';
import { type Client, HttpError, OperationVersionUnavailableError } from '@conservationtv/studio-sdk';
import { getLogger } from '@logtape/logtape';
import { createStore, type EnqueueObject, type ExtractEvents, type Store } from '@xstate/store';
import { expiryOf, withToken } from '../../studio.ts';
import { Alarms, realTime, type Time } from '../../time.ts';
import type { ProgramMediamtx } from './program.ts';
import { PULL_SOURCE_VARIABLE, pullYaml } from './pull.ts';

// One stream relayed into its input path of the program MediaMTX (`inputs/<stream>`, program.ts), by whatever
// delivers it, for as long as OBS reads it (inputs.ts). The studio API says how to read the stream
// (`organisations.streams.connect`), asked as the agent's device with every protocol the agent can play, in its order
// of preference; the relay plays what it answers into the same path, so OBS's input never changes, even when the
// delivery does:
//
//   moq          `moq export rtmp`, pushing the broadcast into the path (MoQ: conservation.tv).
//   rtsps rtmps  a MediaMTX of the relay's own pulling the URL, forwarding it into the path (pull.ts): a MediaMTX
//   rtsp  rtmp   gateway, on the agent's network or the internet. Secure first; a gateway without TLS has no
//                secure servers, which the API cannot tell before choosing, so `gateway_unavailable` asks again
//                for the plain ones.
//
// Every read is renewed `RENEW_BEFORE_MS` before it expires, and how the relay takes the new one depends on what it
// reads by:
//
//   - A pull of the same URL keeps running: a gateway checks a token only as a reader connects, so the pull reads on
//     past its token's expiry. The new token is given to its process, for when it is started again. The one thing an
//     old token can't do is reconnect: MediaMTX retries a dropped source with the URL it started with. So once the
//     token a pull runs with has expired, the input's path is checked every `CHECK_EVERY_MS`, and a pull found not
//     publishing is started again with the latest, at once: the input is dark anyway.
//   - MoQ, or another delivery: the relay ends a MoQ session as its token expires, so `moq` is started again with the
//     new one. That restart is a gap on air: OBS sees its input end, and reconnects after its reconnect delay (1 s,
//     ctv-stream.ts). So restarts are spread out (`book`: inputs.ts keeps every relay's at least `RESTART_SPACING_MS`
//     apart), so cameras that started together don't all blink together each hour. Starting the new one before
//     stopping the old would not narrow the gap: MediaMTX ends every reader of a path when its publisher is replaced,
//     and `moq` was publishing into MediaMTX about 0.1 s after it started, checked by hand against a local relay.
//
// The relay's state is one store; everything that changes it is an event, saying when it happened. Asking the API,
// starting and stopping processes, and checking the path are effects; their outcomes come back as events numbered by
// the ask (`asks`) or the run (`runs`) they are about, so a stale one is dropped. Its timers are read off its state
// (`alarmsOf`).
//
//   ask      idle ─ started ─▶ asking(seq) ─ answered ─▶ holding(until) ─ until passes ─▶ asking
//                                │                                                       ▲
//                                └─ unanswered, or the run failed ─▶ waiting(until) ─────┘
//
//   run      idle ─ an answer, or a replace that's due, or a pull found dark ─▶ starting(seq) ─ ran ─▶ running(seq)
//              ▲                                                                   │
//              └─────────────── run failed: the next answer starts it ◀────────────┘
//
//   replace  none ─ an answer the running process can't carry on with ─▶ booking ─ booked(at) ─▶ due(at)
//              ▲                                                                                  │
//              └────── at passes: run starts the latest; or an answer it can carry on with ───────┘
//
//   stopped, from any: ask stopped, run idle; the shell stops the processes
//
// A first start that fails (no read, or nothing published in time) is emitted as `failed`: the relay is let go of,
// and the next reader tries afresh. Each process is the agent's child (converge's AttachedProcess), restarted if it
// dies, with the latest read.

const logger = getLogger(['agent', 'obs', 'inputs']);

/** How long before a read expires to ask for the next, and the soonest to ask again after a failure. */
export const RENEW_BEFORE_MS = 10 * 60_000;
export const RETRY_MS = 60_000;
/** How far apart the relays' restarts are kept. */
export const RESTART_SPACING_MS = 15_000;
/** How often a pull running on an expired token is checked for being dark. */
export const CHECK_EVERY_MS = 5_000;
/** How long a relay's process may take to publish into its path once started. */
const READY_TIMEOUT_MS = 30_000;
/** How long MediaMTX may take to let go of a stopped process's push. */
const VACATE_MS = 2_000;

/**
 * How stale a group may get before `moq` skips it: RTMP is unpaced, so this bounds what `moq` buffers. Low, as
 * MediaMTX is on the same machine and the stream is live: skipping beats falling behind.
 */
const MAX_AGE = '100ms';

/** The protocols a MediaMTX of the relay's own pulls. */
const PULLED_PROTOCOLS = ['rtsps', 'rtmps', 'rtsp', 'rtmp'] as const;
type PulledProtocol = (typeof PULLED_PROTOCOLS)[number];

/** Every protocol the relay plays, in its order of preference; and the same without the secure ones, to fall back on. */
const PROTOCOLS = ['moq', ...PULLED_PROTOCOLS];
const PLAIN_PROTOCOLS = ['moq', 'rtsp', 'rtmp'];

/** A read of the stream by MoQ: the relay URL, carrying its token as `?jwt=`, and the broadcast. */
interface MoqRead {
  protocol: 'moq';
  url: string;
  broadcast: string;
}

/** A read pulled by URL: the gateway's URL, carrying its token as `?jwt=`. */
interface PulledRead {
  protocol: PulledProtocol;
  url: string;
}

/**
 * A read of the stream, as `organisations.streams.connect` answered it: through which exposure, how, and until when
 * (epoch milliseconds; never, when the API doesn't say). Its URL carries a token: it is never logged.
 */
export type Delivery = (MoqRead | PulledRead) & Delivered;

/** Which exposure a read is of, and until when it admits (epoch milliseconds; never, when the API doesn't say). */
interface Delivered {
  exposureId: string;
  expiresAt: number;
}

/** A URL without its token. */
function withoutToken(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.delete('jwt');
  return parsed.href;
}

/**
 * Whether a process reading `running` reads on as well with `latest` as its credential: the same read, or a pull of
 * the same URL from the same exposure by the same protocol, whose token was only checked as it connected.
 */
export function carriesOn(running: Delivery, latest: Delivery): boolean {
  if (running.exposureId !== latest.exposureId) return false;
  if (running.protocol === 'moq') {
    return latest.protocol === 'moq' && running.url === latest.url && running.broadcast === latest.broadcast;
  }
  return running.protocol === latest.protocol && withoutToken(running.url) === withoutToken(latest.url);
}

interface AskIdle {
  status: 'idle';
}

interface Asking {
  status: 'asking';
  seq: number;
}

/** Holding the latest read until it is time to renew it, or waiting to ask again after a failure. */
interface AskWaiting {
  status: 'holding' | 'waiting';
  /** Epoch milliseconds. */
  until: number;
}

interface AskStopped {
  status: 'stopped';
}

type Ask = AskIdle | Asking | AskWaiting | AskStopped;

interface RunIdle {
  status: 'idle';
}

interface Starting {
  status: 'starting';
  seq: number;
  delivery: Delivery;
}

interface Running {
  status: 'running';
  seq: number;
  /** What the process was started with. */
  delivery: Delivery;
  /** The latest read the process has been given, for when it is started again. */
  credential: Delivery;
  /** When the path was last found published, while a pull runs on an expired token; and whether it is being checked. */
  checkedAt: number | undefined;
  checking: boolean;
}

type RunState = RunIdle | Starting | Running;

interface ReplaceNone {
  status: 'none' | 'booking';
}

interface ReplaceDue {
  status: 'due';
  /** Epoch milliseconds. */
  at: number;
}

/** Whether the running process is to be replaced: not, a time being booked for it, or booked. */
type Replace = ReplaceNone | ReplaceDue;

export interface RelayContext {
  streamId: string;
  asks: number;
  runs: number;
  ask: Ask;
  /** The latest read the API answered with. */
  latest: Delivery | undefined;
  run: RunState;
  /** Replacing what runs with the latest read. */
  replace: Replace;
  /** Whether a process ever ran: until one has, a failure is the relay's end. */
  ran: boolean;
}

interface AtEvent {
  /** Epoch milliseconds. */
  at: number;
}

interface SeqEvent extends AtEvent {
  seq: number;
}

interface AnsweredEvent extends SeqEvent {
  delivery: Delivery;
}

interface FailedEvent extends SeqEvent {
  error: Error;
}

interface ProbedEvent extends SeqEvent {
  publishing: boolean;
}

export type RelayEvents = {
  /** Relay the stream: ask how to read it. */
  started: AtEvent;
  /** Relay nothing more, for good. */
  stopped: AtEvent;
  /** The API answered ask `seq`. */
  answered: AnsweredEvent;
  /** Ask `seq` failed. */
  unanswered: FailedEvent;
  /** It is time to ask again: to renew, or after a failure. */
  askDue: AtEvent;
  /** A restart was given its time. */
  booked: AtEvent;
  /** The booked restart's time came. */
  replaceDue: AtEvent;
  /** Run `seq` publishes into the path. */
  ran: SeqEvent;
  /** Run `seq` couldn't be started, or given the latest read. */
  runFailed: FailedEvent;
  /** It is time to check a pull running on an expired token. */
  checkDue: AtEvent;
  /** Whether run `seq`'s path is published. */
  probed: ProbedEvent;
};

interface FailureEvent {
  error: Error;
}

export type RelayEmitted = {
  /** The relay could not start: none of it runs. */
  failed: FailureEvent;
};

export type RelayStore = Store<RelayContext, RelayEvents, ExtractEvents<RelayEmitted>>;

type Enqueue = EnqueueObject<RelayContext, ExtractEvents<RelayEmitted>, RelayEvents>;

/** What the relay's effects reach. */
export interface RelayIO {
  time: Time;
  /** How to read the stream now. */
  ask: () => Promise<Delivery>;
  /** A new process reading `delivery` into the path, number `seq`: resolves once it publishes there. */
  run: (seq: number, delivery: Delivery) => Promise<void>;
  /** Run `seq`, if it is started again, starts with `delivery`. */
  refresh: (seq: number, delivery: Delivery) => Promise<void>;
  /** When a restart wanted at `at` may happen, apart from every other relay's. */
  book: (at: number) => number;
  /** Whether the path is published now. */
  probe: () => Promise<boolean>;
}

type AlarmName = 'ask' | 'replace' | 'check';

/** What the store is to be woken for, and when (epoch milliseconds). */
export function alarmsOf(context: RelayContext): Map<AlarmName, number> {
  const alarms = new Map<AlarmName, number>();
  const { ask, replace, run, latest } = context;
  if ((ask.status === 'holding' || ask.status === 'waiting') && Number.isFinite(ask.until))
    alarms.set('ask', ask.until);
  if (replace.status === 'due') alarms.set('replace', replace.at);
  if (run.status === 'running' && !run.checking && latest !== undefined && stale(run, latest)) {
    alarms.set('check', Math.max(run.delivery.expiresAt, (run.checkedAt ?? 0) + CHECK_EVERY_MS));
  }
  return alarms;
}

/** Whether a pull runs on a token older than the latest, which it can't reconnect with once that has expired. */
function stale(run: Running, latest: Delivery): boolean {
  return run.delivery.protocol !== 'moq' && run.delivery !== latest && Number.isFinite(run.delivery.expiresAt);
}

/** The relay's store, its effects reaching what `io` does. */
export function relayStore(streamId: string, io: RelayIO): RelayStore {
  const { time } = io;

  function ask(context: RelayContext, enq: Enqueue): RelayContext {
    const seq = context.asks + 1;
    enq.effect(({ trigger }) => {
      io.ask().then(
        delivery => trigger.answered({ seq, delivery, at: time.now() }),
        (error: Error) => trigger.unanswered({ seq, error, at: time.now() })
      );
    });
    return { ...context, asks: seq, ask: { status: 'asking', seq } };
  }

  function start(context: RelayContext, delivery: Delivery, enq: Enqueue): RelayContext {
    const seq = context.runs + 1;
    const { exposureId, protocol } = delivery;
    enq.effect(({ trigger }) => {
      logger.info('Stream {streamId} is read from exposure {exposureId} by {protocol}', {
        streamId,
        exposureId,
        protocol
      });
      io.run(seq, delivery).then(
        () => trigger.ran({ seq, at: time.now() }),
        (error: Error) => trigger.runFailed({ seq, error, at: time.now() })
      );
    });
    return { ...context, runs: seq, run: { status: 'starting', seq, delivery }, replace: { status: 'none' } };
  }

  /**
   * What the running process does about the latest read: carry on, given it as its credential if it is new; or be
   * replaced by it, at a time booked apart from the other relays'.
   */
  function settle(context: RelayContext, enq: Enqueue): RelayContext {
    const { run, latest, replace } = context;
    if (run.status !== 'running' || latest === undefined) return context;
    if (carriesOn(run.delivery, latest)) {
      const next = { ...context, replace: { status: 'none' } as const };
      if (run.credential === latest) return next;
      const { seq } = run;
      enq.effect(({ trigger }) => {
        io.refresh(seq, latest).catch((error: Error) => trigger.runFailed({ seq, error, at: time.now() }));
      });
      return { ...next, run: { ...run, credential: latest } };
    }
    if (replace.status !== 'none') return context;
    enq.effect(({ trigger }) => trigger.booked({ at: io.book(time.now()) }));
    return { ...context, replace: { status: 'booking' } };
  }

  return createStore<RelayContext, RelayEvents, RelayEmitted>({
    context: {
      streamId,
      asks: 0,
      runs: 0,
      ask: { status: 'idle' },
      latest: undefined,
      run: { status: 'idle' },
      replace: { status: 'none' },
      ran: false
    },
    on: {
      started: (context, _event, enq) => {
        if (context.ask.status !== 'idle') return context;
        return ask(context, enq);
      },
      stopped: context => {
        // The shell stops the processes (`Relay.stop`): a run starting meanwhile is aborted.
        return { ...context, ask: { status: 'stopped' }, run: { status: 'idle' }, replace: { status: 'none' } };
      },
      answered: (context, event, enq) => {
        const { ask: asked, run } = context;
        if (asked.status !== 'asking' || asked.seq !== event.seq) return context;
        const { delivery, at } = event;
        const until = Math.max(delivery.expiresAt - RENEW_BEFORE_MS, at + RETRY_MS);
        const next: RelayContext = { ...context, latest: delivery, ask: { status: 'holding', until } };
        if (run.status === 'idle') return start(next, delivery, enq);
        // A run still starting settles once it runs.
        return settle(next, enq);
      },
      // A first ask failing, with nothing run yet, is the relay's end; any other is asked again later.
      unanswered: (context, event, enq) => {
        const { ask: asked } = context;
        if (asked.status !== 'asking' || asked.seq !== event.seq) return context;
        const { error, at } = event;
        enq.effect(() => logger.error('Stream {streamId} cannot be relayed: {error}', { streamId, error }));
        if (!context.ran && context.run.status === 'idle') {
          enq.emit.failed({ error });
          return { ...context, ask: { status: 'stopped' } };
        }
        return { ...context, ask: { status: 'waiting', until: at + RETRY_MS } };
      },
      askDue: (context, event, enq) => {
        const { ask: asked } = context;
        if (asked.status !== 'holding' && asked.status !== 'waiting') return context;
        if (asked.until > event.at) return context;
        return ask(context, enq);
      },
      booked: (context, event) => {
        if (context.replace.status !== 'booking') return context;
        return { ...context, replace: { status: 'due', at: event.at } };
      },
      // The booked time came: the latest read replaces what runs, unless nothing runs to replace.
      replaceDue: (context, event, enq) => {
        const { replace, latest, run } = context;
        if (replace.status !== 'due' || replace.at > event.at) return context;
        if (latest === undefined || run.status !== 'running') return { ...context, replace: { status: 'none' } };
        return start(context, latest, enq);
      },
      ran: (context, event, enq) => {
        const { run } = context;
        if (run.status !== 'starting' || run.seq !== event.seq) return context;
        const { seq, delivery } = run;
        const running: Running = {
          status: 'running',
          seq,
          delivery,
          credential: delivery,
          checkedAt: undefined,
          checking: false
        };
        return settle({ ...context, ran: true, run: running }, enq);
      },
      runFailed: (context, event, enq) => {
        const { run, ask: asked } = context;
        if (run.status === 'idle' || run.seq !== event.seq) return context;
        const { error, at } = event;
        enq.effect(() => logger.error('Stream {streamId} cannot be relayed: {error}', { streamId, error }));
        const next: RelayContext = { ...context, run: { status: 'idle' }, replace: { status: 'none' } };
        if (!context.ran) {
          enq.emit.failed({ error });
          return { ...next, ask: { status: 'stopped' } };
        }
        // The next answer starts it again, with a read asked for afresh.
        if (asked.status === 'asking') return next;
        return { ...next, ask: { status: 'waiting', until: at + RETRY_MS } };
      },
      // A pull on an expired token, not being checked already and due: is its path published?
      checkDue: (context, event, enq) => {
        const { run, latest } = context;
        if (run.status !== 'running' || run.checking || latest === undefined || !stale(run, latest)) return context;
        if (Math.max(run.delivery.expiresAt, (run.checkedAt ?? 0) + CHECK_EVERY_MS) > event.at) return context;
        const { seq } = run;
        enq.effect(({ trigger }) => {
          io.probe().then(
            publishing => trigger.probed({ seq, publishing, at: time.now() }),
            () => trigger.probed({ seq, publishing: true, at: time.now() })
          );
        });
        return { ...context, run: { ...run, checking: true } };
      },
      // Published, or nothing newer to start with: checked again later. Dark: started again with the latest.
      probed: (context, event, enq) => {
        const { run, latest } = context;
        if (run.status !== 'running' || run.seq !== event.seq) return context;
        if (event.publishing || latest === undefined) {
          return { ...context, run: { ...run, checking: false, checkedAt: event.at } };
        }
        enq.effect(() =>
          logger.info('Stream {streamId} lost its source after its read expired: starting it again', { streamId })
        );
        return start(context, latest, enq);
      }
    }
  });
}

/** A stream, as its read is asked for. */
export interface RelayedStream {
  organisationId: string;
  streamId: string;
}

/** What a relay needs: the studio API, the program MediaMTX, the CLIs it runs, and a folder of its own. */
export interface RelayOptions {
  studio: Client;
  program: ProgramMediamtx;
  /** The installed moq CLI and MediaMTX. */
  moq: string;
  mediamtx: string;
  /** The relay's own folder: each process's pid and log, and the pull's config. */
  directory: string;
  /** When a restart wanted at `at` may happen, apart from every other relay's. */
  book: (at: number) => number;
  time?: Time;
}

/**
 * One stream's relay into its path of the program MediaMTX: the shell around its store, running its effects with real
 * processes, and keeping its timers to what its state wants.
 */
export class Relay {
  readonly store: RelayStore;
  private readonly time: Time;
  private readonly stopping = new AbortController();
  private readonly moq: AttachedProcess;
  private readonly pull: AttachedProcess;
  private readonly path: string;
  private readonly config: string;

  constructor(
    private readonly options: RelayOptions,
    private readonly stream: RelayedStream,
    path: string
  ) {
    const { program, directory } = options;
    this.time = options.time ?? realTime;
    this.path = path;
    this.config = join(directory, 'pull.yml');
    // Ready once MediaMTX has the push: before it starts, nothing publishes there, so nothing else is taken for it.
    const probe = (signal: AbortSignal) => program.publishing(path, signal);
    this.moq = new AttachedProcess(directory, { name: 'moq', probe, readyTimeoutMs: READY_TIMEOUT_MS });
    this.pull = new AttachedProcess(directory, { name: 'mediamtx', probe, readyTimeoutMs: READY_TIMEOUT_MS });
    const store = relayStore(stream.streamId, {
      time: this.time,
      ask: () => readDelivery(options.studio, stream),
      run: (seq, delivery) => this.run(seq, delivery),
      refresh: (seq, delivery) => this.refresh(seq, delivery),
      book: at => options.book(at),
      probe: () => program.publishing(path, AbortSignal.timeout(1_000))
    });
    const wanted = () => {
      const snapshot = store.getSnapshot();
      return alarmsOf(snapshot.context);
    };
    const alarms = new Alarms<AlarmName>(this.time, wanted, (name, at) => {
      if (name === 'ask') store.trigger.askDue({ at });
      else if (name === 'replace') store.trigger.replaceDue({ at });
      else store.trigger.checkDue({ at });
    });
    store.subscribe(() => alarms.sync());
    this.store = store;
  }

  /** Relay the stream: rejects if its first read can't be had, or nothing it starts publishes in time. */
  start(): Promise<void> {
    const done = new Promise<void>((resolve, reject) => {
      const failed = this.store.on('failed', ({ error }) => {
        failed.unsubscribe();
        watching.unsubscribe();
        reject(error);
      });
      const watching = this.store.subscribe(snapshot => {
        if (!snapshot.context.ran) return;
        failed.unsubscribe();
        watching.unsubscribe();
        resolve();
      });
    });
    const at = this.time.now();
    this.store.trigger.started({ at });
    return done;
  }

  async stop(): Promise<void> {
    const at = this.time.now();
    this.store.trigger.stopped({ at });
    await this.halt();
  }

  /** Stop both processes, and the path's report. Before they have stopped: see `stop` in inputs.ts. */
  private async halt(): Promise<void> {
    this.stopping.abort();
    this.options.program.removeInput(this.path);
    await Promise.all([this.moq.stop(), this.pull.stop()]);
  }

  /**
   * A new process for `delivery`, in place of whatever runs: that stopped first, and MediaMTX seen to have let go of
   * its push, since a process is refused while something else publishes into its path.
   */
  private async run(seq: number, delivery: Delivery): Promise<void> {
    const { program } = this.options;
    program.setInput(this.path);
    const process = delivery.protocol === 'moq' ? this.moq : this.pull;
    await Promise.all([this.moq.stop(), this.pull.stop()]);
    await this.vacated();
    if (delivery.protocol !== 'moq') {
      const yaml = await pullYaml(program.pathUrl(this.path));
      await mkdir(this.options.directory, { recursive: true });
      await writeFile(this.config, yaml);
    }
    await process.ensure(this.processRun(seq, delivery), this.stopping.signal);
  }

  /** Until nothing publishes into the path, for at most `VACATE_MS`. */
  private async vacated(): Promise<void> {
    const { program } = this.options;
    const deadline = this.time.now() + VACATE_MS;
    while (this.time.now() < deadline && (await program.publishing(this.path, AbortSignal.timeout(1_000)))) {
      await delay(50, undefined, { signal: this.stopping.signal });
    }
  }

  /** Run `seq`'s process, if it is started again, starts with `delivery`: the same key, so it isn't restarted now. */
  private async refresh(seq: number, delivery: Delivery): Promise<void> {
    const process = delivery.protocol === 'moq' ? this.moq : this.pull;
    await process.ensure(this.processRun(seq, delivery), this.stopping.signal);
  }

  /**
   * What run `seq` runs for `delivery`, keyed by the run, so each run is a new process. The read's URL is given in the
   * environment, never on the command line: `moq` takes its relay as `MOQ_CONNECT`, a pull its source as MediaMTX's
   * setting for its path (pull.ts).
   */
  private processRun(seq: number, delivery: Delivery): Run {
    const key = String(seq);
    if (delivery.protocol !== 'moq') {
      const env = { [PULL_SOURCE_VARIABLE]: delivery.url };
      return { key, binary: this.options.mediamtx, args: [this.config], env };
    }
    const target = this.options.program.pathUrl(this.path);
    const args = ['--broadcast', delivery.broadcast, 'export', 'rtmp', '--connect', target, '--max-age', MAX_AGE];
    return { key, binary: this.options.moq, args, env: { NO_COLOR: '1', MOQ_CONNECT: delivery.url } };
  }
}

/**
 * The studio API doesn't serve `organisations.streams.connect` at a version this agent has: it is older than the
 * agent, and nothing can be relayed until it is updated (inputs.ts holds off asking).
 */
export class StudioTooOldError extends Error {
  constructor(options: ErrorOptions) {
    super('the studio API is older than this agent: it does not serve organisations.streams.connect', options);
  }
}

/**
 * How to read the stream, as the device, by whatever delivers it: by every protocol the relay plays, falling back to
 * the plain ones when the gateway chosen has no secure server. Throws if the API refuses it, is too old to be asked
 * (`StudioTooOldError`), or answers with a protocol the relay can't play.
 */
async function readDelivery(studio: Client, stream: RelayedStream): Promise<Delivery> {
  const answer = await connectStream(studio, stream, PROTOCOLS);
  if (answer instanceof OperationVersionUnavailableError && answer.negotiated === undefined) {
    throw new StudioTooOldError({ cause: answer });
  }
  if (answer instanceof HttpError && answer.code === 'gateway_unavailable') {
    const plain = await connectStream(studio, stream, PLAIN_PROTOCOLS);
    return deliveryOf(stream, plain);
  }
  return deliveryOf(stream, answer);
}

function connectStream(studio: Client, stream: RelayedStream, protocols: string[]) {
  return studio.organisations.streams.connect.v1({ id: stream.organisationId, streamId: stream.streamId, protocols });
}

type Answer = Awaited<ReturnType<typeof connectStream>>;

function deliveryOf(stream: RelayedStream, answer: Answer): Delivery {
  if (answer instanceof Error) throw answer;
  const { connection, exposureId } = answer;
  const expiresAt = expiryOf(connection);
  if ('relay' in connection) {
    const url = withToken(new URL(connection.path, connection.relay), connection.token);
    return { protocol: 'moq', url, broadcast: connection.broadcast, exposureId, expiresAt };
  }
  const protocol = PULLED_PROTOCOLS.find(pulled => pulled === connection.protocol);
  if (protocol === undefined) {
    throw new Error(`Stream ${stream.streamId} is delivered by ${connection.protocol}, which OBS cannot be given`);
  }
  // Not `new URL` alone: what it throws for a URL it can't parse carries the URL, and with it the token.
  if (!URL.canParse(connection.url))
    throw new Error(`Stream ${stream.streamId} is delivered at a URL that can't be read`);
  const url = withToken(new URL(connection.url), connection.token);
  return { protocol, url, exposureId, expiresAt };
}
