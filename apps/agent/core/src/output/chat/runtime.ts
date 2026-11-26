import { BehaviorSubject } from 'rxjs';
import type { Courier } from '../../cameras/courier.ts';
import { useStudio } from '../../studio.ts';
import { Alarms, realTime, type Time } from '../../time.ts';
import { type Connect, TwitchChat } from './twitch.ts';
import { alarmsOf, type ChatSpec, type ChatStudio, ringOf, studioOf, type UsesStore, usesStore } from './uses.ts';

// The `chat` key: listening to the chat of the channels the spec lists (those the output goes out to, and those whose
// chat controls its broadcast), for the standard commands and the organisation's own. The agent only listens. When a
// command's word is used it tells the studio API (`organisations.chatCommands.uses.create`), which decides whether it
// runs, what it does, and what is said back in chat; the agent then carries out whatever camera commands came of it, in
// order (cameras/courier.ts), and says what came of them (`organisations.chatCommands.uses.settle`).
// Listening here, not in the studio API, keeps a connection open only where a show is going out, and costs the studio
// a request only when a command is used.
//
// A use that would come to nothing isn't told to the studio API: one by someone outside the command's audience, or of a
// command resting until the time the studio API last said. And a command is told of at most once at a time, and no more
// often than every second and a half: a standard command per camera or per show, as it rests (uses.ts). That is all the
// agent decides itself, to keep a busy chat from becoming a busy API; the studio API decides it all again, and its
// answer is the one that counts.
//
// Two stores hold it all: the connection to Twitch's chat (twitch.ts) and the uses of the commands (uses.ts), where
// their machines are drawn. This class is the shell around them: it turns each call into their events, passes each
// message heard on to the uses, keeps the uses' timers to what their state wants, and reads the status off both. It
// keeps no state of its own.

export {
  ChatSpecSchema,
  type ChatChannel,
  type ChatSpec,
  type ChatStudio,
  type ListenedCommand,
  type ListenedStandardCommand
} from './uses.ts';

export interface ChatStatus {
  /** Whether the connection to the channels' chat is open. */
  connected: boolean;
  channels: number;
  /** How many commands are listened for: the standard ones and the organisation's own. */
  commands: number;
  /** How many uses of a command were told to the studio API since the agent started. */
  triggered: number;
  /** ISO 8601: when a command was last used. */
  lastTriggeredAt: string | null;
}

/** What a chat runtime is built with: the real clock, timers, WebSocket and studio API unless told otherwise. */
export interface ChatRuntimeOptions {
  time?: Time;
  connect?: Connect;
  studio?: ChatStudio;
}

/** The studio API's chat use calls, on the agent's client. */
function agentStudio(): ChatStudio {
  const client = useStudio();
  return studioOf(client);
}

/** Listens to the spec's channels for the spec's commands, and tells the studio API when one is used. */
export class ChatRuntime {
  readonly status$: BehaviorSubject<ChatStatus>;
  private readonly time: Time;
  private readonly twitch: TwitchChat;
  private readonly uses: UsesStore;
  private readonly alarms: Alarms;
  /** Calls off everything in flight, when the runtime is disposed of. */
  private readonly ends = new AbortController();

  constructor(courier: Courier, options: ChatRuntimeOptions = {}) {
    const time = options.time ?? realTime;
    const studio = options.studio ?? agentStudio();
    const twitch = new TwitchChat({ time, connect: options.connect });
    const uses = usesStore({ time, studio, courier, ends: this.ends.signal });
    const wanted = () => {
      const snapshot = uses.getSnapshot();
      return alarmsOf(snapshot.context);
    };
    const ring = (name: string, at: number) => {
      const event = ringOf(name, at);
      uses.send(event);
    };
    const alarms = new Alarms(time, wanted, ring);
    this.time = time;
    this.twitch = twitch;
    this.uses = uses;
    this.alarms = alarms;
    const status = this.statusOf();
    this.status$ = new BehaviorSubject(status);
    twitch.store.on('heard', ({ message, at }) => uses.trigger.heard({ message, at }));
    uses.subscribe(() => alarms.sync());
    uses.subscribe(() => this.derive());
    twitch.store.subscribe(() => this.derive());
  }

  /** Listen to the spec's channels for its commands from now on. */
  async apply(spec: ChatSpec): Promise<void> {
    const at = this.time.now();
    this.uses.trigger.applied({ spec, at });
    const logins = spec.channels.map(channel => channel.login);
    this.twitch.listen(logins);
  }

  /** Stop listening, seeing through what is already in flight. Safe when it never started. */
  async teardown(): Promise<void> {
    const at = this.time.now();
    this.uses.trigger.stopped({ at });
    this.twitch.stop();
  }

  /** Stop everything at once: what is in flight is called off, and no timer is left set. */
  dispose(): void {
    const at = this.time.now();
    this.uses.trigger.disposed({ at });
    this.ends.abort();
    this.twitch.close();
  }

  /** The status, as the stores say it. */
  private statusOf(): ChatStatus {
    const { context } = this.uses.getSnapshot();
    const { life, triggered, lastTriggeredAt } = context;
    // Zeroes while there is no spec.
    const spec = life.status === 'listening' ? life.spec : undefined;
    const commands = spec === undefined ? 0 : spec.commands.length + spec.standard.length;
    return {
      connected: this.twitch.connected,
      channels: spec?.channels.length ?? 0,
      commands,
      triggered,
      lastTriggeredAt
    };
  }

  /** Publish the status when it changed. */
  private derive(): void {
    const status = this.statusOf();
    const current = this.status$.getValue();
    if (JSON.stringify(current) === JSON.stringify(status)) return;
    this.status$.next(status);
  }
}
