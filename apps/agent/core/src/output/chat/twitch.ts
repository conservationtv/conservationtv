import type { ChatAudience } from '@conservationtv/chat';
import { getLogger } from '@logtape/logtape';
import { createStore, type EnqueueObject, type ExtractEvents, type Store } from '@xstate/store';
import { Alarms, realTime, type Time } from '../../time.ts';

// Reading a Twitch channel's chat, without an account: Twitch's chat is IRC over a WebSocket, and anyone may read a
// public channel's as `justinfan<digits>`, with no token. So the agent holds no Twitch credential to listen; what is
// said back in chat is said by the studio API, which holds the channel's tokens. With the `tags` capability each
// message says who sent it and what they are in the channel (its badges), which is who a command's audience is told by.
//
// The connection is one store. Everything that changes it is an event below, and each says when it happened: the store
// never reads the clock, and never touches a socket itself. Making a socket, sending a line on it and closing it are
// effects a change asks for; the socket's own events come back as events, each naming the socket by its number
// (`seq`), so one from a socket that has been replaced is told from the live one's and dropped. The wait before
// connecting again is state too, and its timer is read off it (`alarmsOf`). Exactly one socket is ever live: the one
// the state holds. Every other the store made it has closed, or it closes it as soon as it hears of it.
//
//             listen                socket made                       opened
//     idle ───────────▶ dialling(seq) ───────────▶ connecting(seq) ─────────────▶ open(seq, joined)
//                         ▲    ▲    │                    │                           │   │
//                         │    │    │ it couldn't        │ closed, or failed         │   │ RECONNECT: this socket
//                         │    │    │ be made            │                           │   │ closed, and another
//                         │    │    ▼                    ▼       closed, or failed   │   │ dialled at once
//                         │    │  waiting(retries, until) ◀──────────────────────────┘   │
//                         │    │    │                                                    │
//                         │    └────┘ the wait ends                                      │
//                         └──────────────────────────────────────────────────────────────┘
//
//     stop, from any but closed: idle, with the live socket closed            close, from any: closed, for good
//
// A drop waits before connecting again: `RECONNECT_MIN_MS` after a connection that had opened, and twice as long each
// time in a row it doesn't open again, up to `RECONNECT_MAX_MS`. Being told which channels to listen to doesn't cut
// the wait short, since a change of channels says nothing about whether Twitch can be reached.
//
// Which channels to listen to (`wanted`) is kept apart from which the open socket has joined (`joined`): a socket
// joins all that are wanted when it opens, and each change while it is open joins those that are new and leaves those
// dropped, so the two are the same whenever it is open. Twitch's `PING`s are answered, and it asks for a reconnect
// itself now and then (`RECONNECT`). What it sends comes in frames of whole lines; one that ends mid-line keeps the
// rest for the next frame.

const logger = getLogger(['agent', 'chat']);

const TWITCH_CHAT_URL = 'wss://irc-ws.chat.twitch.tv:443';
/** How long to wait before connecting again after a connection that had opened drops. */
export const RECONNECT_MIN_MS = 1_000;
/** The longest wait, however many tries in a row haven't opened. */
export const RECONNECT_MAX_MS = 60_000;
/** The most of a line kept waiting for the rest of it: far beyond any line Twitch sends. */
const MAX_PARTIAL_LENGTH = 16_384;

/** What someone is in a channel, as its badges say: the studio API's chat audiences, but `everyone`. */
export type ChatRole = Exclude<ChatAudience, 'everyone'>;

/** One message in a channel's chat. */
export interface ChatMessage {
  /** The channel's login, without its `#`. */
  channel: string;
  /** The message's ID on Twitch, to answer it. */
  id: string;
  text: string;
  user: ChatUser;
}

/** Who sent a message. */
export interface ChatUser {
  id: string;
  name: string;
  roles: ChatRole[];
}

/** An IRC message's tags: `@key=value;key=value`, each value unescaped enough for what is read here. */
function tagsOf(raw: string): Map<string, string> {
  const tags = new Map<string, string>();
  for (const pair of raw.split(';')) {
    const equals = pair.indexOf('=');
    if (equals > 0) tags.set(pair.slice(0, equals), pair.slice(equals + 1).replaceAll(String.raw`\s`, ' '));
  }
  return tags;
}

/** The badges each role is told by. */
const ROLE_BADGES: ReadonlyArray<readonly [ChatRole, readonly string[]]> = [
  ['broadcaster', ['broadcaster']],
  ['moderator', ['moderator']],
  ['vip', ['vip']],
  ['subscriber', ['subscriber', 'founder']]
];

/** What the sender is in the channel, from their badges (`broadcaster/1,subscriber/12`). */
function rolesOf(tags: Map<string, string>): ChatRole[] {
  const badges = new Set((tags.get('badges') ?? '').split(',').map(badge => badge.split('/')[0] ?? ''));
  return ROLE_BADGES.filter(([, named]) => named.some(badge => badges.has(badge))).map(([role]) => role);
}

/** A chat message, from one line of IRC; undefined for any other line. */
export function parseChatMessage(line: string): ChatMessage | undefined {
  const match = /^@(\S+) :(\w+)!\S+ PRIVMSG #(\w+) :(.*)$/u.exec(line);
  if (match === null) return undefined;
  const [, rawTags = '', login = '', channel = '', text = ''] = match;
  const tags = tagsOf(rawTags);
  const id = tags.get('id');
  const userId = tags.get('user-id');
  if (id === undefined || userId === undefined) return undefined;
  const name = tags.get('display-name') || login;
  return { channel, id, text, user: { id: userId, name, roles: rolesOf(tags) } };
}

/** What a socket's event carries: a `message`'s data, and nothing that is read of the others. */
export interface ChatSocketEvent {
  data?: unknown;
}

/** As much of a WebSocket as the connection uses. */
export interface ChatSocket {
  send: (data: string) => void;
  close: () => void;
  addEventListener: (type: 'open' | 'message' | 'close' | 'error', listener: (event: ChatSocketEvent) => void) => void;
}

/** Opens a WebSocket to the URL: the platform's own, unless told otherwise. */
export type Connect = (url: string) => ChatSocket;

export const realConnect: Connect = url => new WebSocket(url);

interface Idle {
  status: 'idle';
}

interface Dialling {
  status: 'dialling';
  /** The socket being made. */
  seq: number;
  /** How many connections in a row have failed to open before this one. */
  retries: number;
}

interface Connecting {
  status: 'connecting';
  seq: number;
  retries: number;
  socket: ChatSocket;
}

interface Open {
  status: 'open';
  seq: number;
  socket: ChatSocket;
  /** The channels this socket has joined, by login. */
  joined: string[];
  /** The end of the last frame, when it stopped mid-line. */
  partial: string;
}

interface Waiting {
  status: 'waiting';
  retries: number;
  /** Epoch milliseconds: when it connects again. */
  until: number;
}

interface Closed {
  status: 'closed';
}

/** Where the connection to Twitch's chat is. */
export type Connection = Idle | Dialling | Connecting | Open | Waiting | Closed;

export interface TwitchContext {
  /** The channels to listen to, by login, lower case. */
  wanted: string[];
  /** The last number given to a socket. */
  seq: number;
  connection: Connection;
}

interface AtEvent {
  /** Epoch milliseconds. */
  at: number;
}

interface ListenedEvent extends AtEvent {
  channels: string[];
}

interface SocketEvent extends AtEvent {
  /** The socket it happened to. */
  seq: number;
}

/** A socket opened, with the digits to read chat as: anyone may, as `justinfan` and some digits, with no password. */
interface OpenedEvent extends SocketEvent {
  digits: number;
}

interface DialledEvent extends SocketEvent {
  socket: ChatSocket;
}

interface ReceivedEvent extends SocketEvent {
  data: string;
}

export type TwitchEvents = {
  /** Listen to these channels, by login, from now on: connecting first, if the connection is idle. */
  listened: ListenedEvent;
  /** Listen to nothing: the live socket is closed, any wait called off, and the connection is idle. */
  stopped: AtEvent;
  /** Listen to nothing, for good. */
  closed: AtEvent;
  /** The socket being dialled was made. */
  dialled: DialledEvent;
  /** A socket opened. */
  opened: OpenedEvent;
  /** A socket brought a frame of what Twitch said. */
  received: ReceivedEvent;
  /** A socket closed, or couldn't be made. */
  dropped: SocketEvent;
  /** A socket failed: closed by the store, if it is the live one, and dropped. */
  failed: SocketEvent;
  /** The wait before connecting again came to its end. */
  retryDue: AtEvent;
};

export interface HeardEvent extends AtEvent {
  message: ChatMessage;
}

export type TwitchEmitted = {
  /** A chat message, heard on the live socket. */
  heard: HeardEvent;
};

export type TwitchStore = Store<TwitchContext, TwitchEvents, ExtractEvents<TwitchEmitted>>;

type Enqueue = EnqueueObject<TwitchContext, ExtractEvents<TwitchEmitted>, TwitchEvents>;

/** What the connection's effects reach: the clock, and how a socket is made. */
export interface TwitchIO {
  time: Time;
  connect: Connect;
}

const IDLE: Connection = { status: 'idle' };
const CLOSED: Connection = { status: 'closed' };

/** How long to wait before connecting again, after this many connections in a row that didn't open. */
export function backoffOf(retries: number): number {
  return Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** retries);
}

/** The channels as Twitch names them: lower case, each once. */
function loginsOf(channels: string[]): string[] {
  const lower = channels.map(channel => channel.toLowerCase());
  return [...new Set(lower)];
}

/** An IRC line naming these channels: `JOIN #a,#b`. */
function channelLine(verb: 'JOIN' | 'PART', channels: string[]): string {
  const named = channels.map(channel => `#${channel}`);
  return `${verb} ${named.join(',')}`;
}

/** The live socket, if there is one. */
export function socketOf(connection: Connection): ChatSocket | undefined {
  return connection.status === 'connecting' || connection.status === 'open' ? connection.socket : undefined;
}

/** Whether this event's socket is the one the connection is on. */
function current(connection: Connection, seq: number): boolean {
  if (connection.status === 'dialling' || connection.status === 'connecting' || connection.status === 'open')
    return connection.seq === seq;
  return false;
}

/** What the store is to be woken for, and when (epoch milliseconds): the end of the wait, `retryDue`. */
export function alarmsOf(context: TwitchContext): Map<'retry', number> {
  const { connection } = context;
  const alarms = new Map<'retry', number>();
  if (connection.status === 'waiting') alarms.set('retry', connection.until);
  return alarms;
}

/** The connection's store, its effects making sockets through `io`. */
export function twitchStore(io: TwitchIO): TwitchStore {
  const { time, connect } = io;

  /** Send these lines on the socket, as they are: one it fails to take is dropped by its own `close`. */
  function send(socket: ChatSocket, lines: string[], enq: Enqueue): void {
    if (lines.length === 0) return;
    enq.effect(() => {
      try {
        for (const line of lines) socket.send(`${line}\r\n`);
      } catch (error) {
        logger.warn('A line to Twitch chat could not be sent: {error}', { error });
      }
    });
  }

  function close(socket: ChatSocket | undefined, enq: Enqueue): void {
    if (socket === undefined) return;
    enq.effect(() => {
      try {
        socket.close();
      } catch (error) {
        logger.warn('The connection to Twitch chat could not be closed: {error}', { error });
      }
    });
  }

  /** A socket to Twitch's chat, or what kept it from being made. */
  function made(): ChatSocket | Error {
    try {
      return connect(TWITCH_CHAT_URL);
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  }

  /** Make a new socket, the next by number, which reports back as `dialled`, or `dropped` if it can't be made. */
  function dial(context: TwitchContext, retries: number, enq: Enqueue): TwitchContext {
    const seq = context.seq + 1;
    enq.effect(({ trigger }) => {
      const socket = made();
      if (socket instanceof Error) {
        logger.warn('The connection to Twitch chat could not be made: {error}', { error: socket });
        trigger.dropped({ seq, at: time.now() });
        return;
      }
      socket.addEventListener('open', () =>
        trigger.opened({ seq, at: time.now(), digits: Math.floor(10_000 + Math.random() * 80_000) })
      );
      socket.addEventListener('message', event => trigger.received({ seq, data: String(event.data), at: time.now() }));
      socket.addEventListener('close', () => trigger.dropped({ seq, at: time.now() }));
      socket.addEventListener('error', () => trigger.failed({ seq, at: time.now() }));
      trigger.dialled({ seq, socket, at: time.now() });
    });
    return { ...context, seq, connection: { status: 'dialling', seq, retries } };
  }

  /** The connection after its socket went: waiting to connect again, the wait growing while none opens. */
  function dropped(context: TwitchContext, at: number): TwitchContext {
    const { connection } = context;
    const retries = connection.status === 'dialling' || connection.status === 'connecting' ? connection.retries : 0;
    const until = at + backoffOf(retries);
    return { ...context, connection: { status: 'waiting', retries, until } };
  }

  return createStore<TwitchContext, TwitchEvents, TwitchEmitted>({
    context: { wanted: [], seq: 0, connection: IDLE },
    on: {
      listened: (context, event, enq) => {
        const { connection } = context;
        if (connection.status === 'closed') return context;
        const wanted = loginsOf(event.channels);
        const next = { ...context, wanted };
        if (connection.status === 'idle') return dial(next, 0, enq);
        if (connection.status !== 'open') return next;
        // Open: join those that are new, and leave those dropped, so what is joined is what is wanted.
        const joined = new Set(connection.joined);
        const leaving = connection.joined.filter(channel => !wanted.includes(channel));
        const joining = wanted.filter(channel => !joined.has(channel));
        const lines: string[] = [];
        if (leaving.length > 0) lines.push(channelLine('PART', leaving));
        if (joining.length > 0) lines.push(channelLine('JOIN', joining));
        send(connection.socket, lines, enq);
        return { ...next, connection: { ...connection, joined: wanted } };
      },
      stopped: (context, _event, enq) => {
        if (context.connection.status === 'closed') return context;
        const live = socketOf(context.connection);
        close(live, enq);
        return { ...context, wanted: [], connection: IDLE };
      },
      closed: (context, _event, enq) => {
        const live = socketOf(context.connection);
        close(live, enq);
        return { ...context, wanted: [], connection: CLOSED };
      },
      dialled: (context, event, enq) => {
        const { connection } = context;
        const { seq, socket } = event;
        // A socket that is no longer wanted, made after the connection moved on, is closed at once.
        if (connection.status !== 'dialling' || connection.seq !== seq) {
          close(socket, enq);
          return context;
        }
        return { ...context, connection: { status: 'connecting', seq, retries: connection.retries, socket } };
      },
      opened: (context, event, enq) => {
        const { connection, wanted } = context;
        if (connection.status !== 'connecting' || connection.seq !== event.seq) return context;
        const { seq, socket } = connection;
        const lines = ['CAP REQ :twitch.tv/tags twitch.tv/commands'];
        lines.push(`NICK justinfan${event.digits}`);
        if (wanted.length > 0) lines.push(channelLine('JOIN', wanted));
        send(socket, lines, enq);
        return { ...context, connection: { status: 'open', seq, socket, joined: wanted, partial: '' } };
      },
      received: (context, event, enq) => {
        const { connection } = context;
        if (connection.status !== 'open' || connection.seq !== event.seq) return context;
        const lines = `${connection.partial}${event.data}`.split('\r\n');
        // What follows the last line's end is the start of a line still to come.
        const rest = lines.pop() ?? '';
        const partial = rest.length > MAX_PARTIAL_LENGTH ? '' : rest;
        const pongs: string[] = [];
        for (const line of lines) {
          // Each line is one of the three: anything else Twitch says (joins, notices) is of no use here.
          if (line.startsWith('PING')) pongs.push(`PONG${line.slice(4)}`);
          else if (/^:\S+ RECONNECT/u.test(line)) {
            // Twitch is about to close this socket: a new one is made now, and the rest of this one is not heard.
            send(connection.socket, pongs, enq);
            close(connection.socket, enq);
            return dial(context, 0, enq);
          } else {
            const message = parseChatMessage(line);
            if (message !== undefined) enq.emit.heard({ message, at: event.at });
          }
        }
        send(connection.socket, pongs, enq);
        return { ...context, connection: { ...connection, partial } };
      },
      dropped: (context, event) => {
        if (!current(context.connection, event.seq)) return context;
        return dropped(context, event.at);
      },
      failed: (context, event, enq) => {
        // A failure closes the socket too, and its `close` would say so; it is closed here all the same, so it can't
        // linger alongside the next.
        if (!current(context.connection, event.seq)) return context;
        enq.effect(() => logger.warn('The connection to Twitch chat failed'));
        const live = socketOf(context.connection);
        close(live, enq);
        return dropped(context, event.at);
      },
      retryDue: (context, event, enq) => {
        const { connection } = context;
        if (connection.status !== 'waiting' || connection.until > event.at) return context;
        return dial(context, connection.retries + 1, enq);
      }
    }
  });
}

/** What a Twitch chat connection is built with: the real clock, timers and WebSocket unless told otherwise. */
export interface TwitchChatOptions {
  time?: Time;
  connect?: Connect;
}

/**
 * Listens to Twitch channels' chat, telling each message (`heard`, on its store), until closed. The shell around the
 * connection's store: it turns each call into an event, and keeps the store's one timer to what its state wants.
 */
export class TwitchChat {
  readonly store: TwitchStore;
  private readonly time: Time;
  private readonly alarms: Alarms<'retry'>;

  constructor(options: TwitchChatOptions = {}) {
    const time = options.time ?? realTime;
    const connect = options.connect ?? realConnect;
    const store = twitchStore({ time, connect });
    const wanted = () => {
      const snapshot = store.getSnapshot();
      return alarmsOf(snapshot.context);
    };
    const alarms = new Alarms<'retry'>(time, wanted, (_name, at) => store.trigger.retryDue({ at }));
    store.subscribe(() => alarms.sync());
    this.store = store;
    this.time = time;
    this.alarms = alarms;
  }

  /** Whether the connection to Twitch is open. */
  get connected(): boolean {
    const snapshot = this.store.getSnapshot();
    return snapshot.context.connection.status === 'open';
  }

  /** Listen to these channels, by login, from now on: joining those that are new, and leaving those dropped. */
  listen(channels: string[]): void {
    const at = this.time.now();
    this.store.trigger.listened({ channels, at });
  }

  /** Listen to nothing until told to listen again. */
  stop(): void {
    const at = this.time.now();
    this.store.trigger.stopped({ at });
  }

  /** Stop listening, for good. */
  close(): void {
    const at = this.time.now();
    this.store.trigger.closed({ at });
  }
}
