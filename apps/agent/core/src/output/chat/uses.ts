import { chatName } from '@conservationtv/cameras';
import { CHAT_AUDIENCES, type CarryResult, inAudience, STANDARD_TARGETS } from '@conservationtv/chat';
import type { Client } from '@conservationtv/studio-sdk';
import { getLogger } from '@logtape/logtape';
import { createStore, type EnqueueObject, type ExtractEvents, type Store } from '@xstate/store';
import { z } from 'zod';
import type { CarriedCommand, Courier } from '../../cameras/courier.ts';
import { type Time, within } from '../../time.ts';
import type { ChatMessage, ChatUser } from './twitch.ts';

// The uses of the spec's commands heard in chat, in one store: what each command is doing with the uses it has heard,
// and whether the runtime listens at all. Everything that changes is an event below, and each says when it happened:
// the store never reads the clock, and never calls the studio API or the courier itself. Telling the studio API of a
// use, carrying what it planned and settling it are effects a change asks for, each reporting back as an event; the
// waits are read off the state (`alarmsOf`), and `Alarms` keeps the timers that say so.
//
//   life     whether chat is listened to for the spec's commands:
//
//              stopped ── applied ──▶ listening(spec) ── stopped ──▶ stopped        disposed, from either, for good
//                            ▲              │
//                            └── applied ───┘ (a new spec)
//
//   each command, by its key (`keyOf`). One with nothing in hand whose quiet is over is ready, and isn't kept at all:
//
//                                     a use, its quiet over
//       ┌─────────────────────────────────────────────────────────────────────────┐
//       │                                                                         ▼
//     ready ── a use, in its quiet ──▶ spaced(use) ── its quiet ends ──────────▶ telling ── planned ──▶ carrying
//       ▲                                 ▲                                       │  ▲                     │
//       │                                 │                    ran, notRun, or    │  │                     │ carried, as
//       │                                 │                    not answered       │  │ a use waited,       ▼ far as it went
//       │                                 │                                       ▼  │ its quiet over    settling
//       │                                 └──── a use waited, in its quiet ──── answered ◀─────────────────┘ settled,
//       │                                                                        │  │                         or not
//       ├──────────────────────────────── nothing waited ────────────────────────┘  │ resting, as the studio API
//       │                                                                           ▼ last said
//       └──────────────────────────────── its rest ends ──────────────────── resting(until)
//
//            `answered` is not a state: it is where a tell's answer decides what comes next (`through`), in the order
//            drawn: rest if the studio API says it rests, else tell the use that waited, else be ready. While a tell is
//            in flight (telling, carrying, settling), a use heard waits for it, the latest taking the place of any
//            before; while the command rests, a use heard is dropped.
//
// One tell is in flight for a command at a time, and its answer decides what happens next. `restsUntil`, as the studio
// API last said it, is the only rest a command has here: while it rests, a use of it is dropped, never told, since the
// studio API would only say it rests. A use heard while a tell is in flight waits for its answer: only the latest one
// waits, each newer one taking the place of the last, so a burst of the same command costs one tell and then the
// burst's last word. Once the answer comes, the waiting use is told, unless the command then rests, and it is dropped.
// So a typo in flight never swallows a correct use for longer than one answer.
//
// The studio API spends nothing for a use that doesn't run (`unresolved`, `unavailable`, and so on), so nothing it
// says would stop a typo said over and over from becoming a request each time. So there is a quiet after each tell:
// the next is told no sooner than `MIN_GAP_MS` after it was, and a use heard before then waits in `spaced` for it,
// the latest again taking the place of any before.
//
// A `planned` use has camera commands: they are carried, in order, until one isn't (cameras/courier.ts), and the use
// is settled with what came of them, once, with nothing retried: the receipt lasts a minute, and the carry and the
// settle each give up long before that. A settle that fails is logged, and the command rests as the plan said.
//
// A command's state is kept by its key, which is what it rests by. An organisation's own command rests as one, and is
// kept by its ID. A standard command rests per camera or per show, as its `target` says, which only the studio API
// resolves: one that acts on a camera is kept by its name and the camera its first word names, as chat writes camera
// names (`standard:ptzload:pond`), and one that acts on the show by its name alone (`standard:swap`). The `restsUntil`
// the studio API answers is that key's. The same camera named another way (by its alias, or its position) is another
// key here, and only the studio API holds it to the camera's one rest.
//
// A new spec keeps what each command is doing, its rest and quiet too, even for a command it no longer has, in case it
// comes back: only a use waiting on a command or channel the spec no longer has is dropped.
//
// Stopping (teardown) tells nothing new: the uses waiting are dropped, rests are forgotten (they would need timers),
// and a tell in flight is seen through, so a use the studio API planned is still carried and settled, since it has
// spent the command's turn and chat is waiting to hear of it. Each command keeps only its quiet, which needs no timer.
// Disposing stops everything at once: what is in flight is called off (`ends`), and whatever answers afterwards is
// dropped, a planned use left unsettled for its receipt to lapse.

const logger = getLogger(['agent', 'chat']);

/** The least time between two tells of the same command. */
export const MIN_GAP_MS = 1_500;
/** How long the studio API has to answer a tell. */
export const TELL_TIMEOUT_MS = 15_000;
/** How long carrying a planned use's camera commands may take, all of them: well within its receipt's minute. */
export const CARRY_TIMEOUT_MS = 30_000;
/** How long the studio API has to answer a settle. */
export const SETTLE_TIMEOUT_MS = 10_000;

/** The most words after a command that are passed on, and the longest each may be, as the studio API takes them. */
const MAX_WORDS = 8;
const MAX_WORD_LENGTH = 60;

const ChatChannelSchema = z.object({ channelId: z.string(), platform: z.literal('twitch'), login: z.string() });
export type ChatChannel = z.output<typeof ChatChannelSchema>;

const ListenedCommandSchema = z.object({
  id: z.string(),
  name: z.string(),
  audience: z.enum(CHAT_AUDIENCES).default('everyone'),
  cooldownSeconds: z.number()
});
export type ListenedCommand = z.output<typeof ListenedCommandSchema>;

const ListenedStandardCommandSchema = z.object({
  name: z.string(),
  /** The words it is used by: its name and its aliases. */
  words: z.array(z.string()),
  audience: z.enum(CHAT_AUDIENCES),
  cooldownSeconds: z.number(),
  /** What it acts on, which it rests per. */
  target: z.enum(STANDARD_TARGETS)
});
export type ListenedStandardCommand = z.output<typeof ListenedStandardCommandSchema>;

export const ChatSpecSchema = z.object({
  organisationId: z.string(),
  /** The channels whose chat to listen to. */
  channels: z.array(ChatChannelSchema),
  /** The organisation's own commands to listen for, by the word each is used by. */
  commands: z.array(ListenedCommandSchema),
  /** The standard commands to listen for, by any of their words: none from a configuration from before them. */
  standard: z.array(ListenedStandardCommandSchema).default([])
});
export type ChatSpec = z.output<typeof ChatSpecSchema>;

type UseCalls = Client['organisations']['chatCommands']['uses'];
type CreateCall = UseCalls['create']['v1'];
type SettleCall = UseCalls['settle']['v1'];
export type UseInput = Parameters<CreateCall>[0];
export type UseAnswer = Exclude<Awaited<ReturnType<CreateCall>>, Error>;
export type SettleInput = Parameters<SettleCall>[0];
export type SettleAnswer = Exclude<Awaited<ReturnType<SettleCall>>, Error>;

/** The two calls the uses make of the studio API, each given up on once `signal` aborts. */
export interface ChatStudio {
  /** Tell it of a use (`organisations.chatCommands.uses.create`). */
  create: (input: UseInput, signal: AbortSignal) => Promise<UseAnswer | Error>;
  /** Say what came of a planned use (`organisations.chatCommands.uses.settle`). */
  settle: (input: SettleInput, signal: AbortSignal) => Promise<SettleAnswer | Error>;
}

/** The studio API's chat use calls, on its client. */
export function studioOf(client: Client): ChatStudio {
  const { create, settle } = client.organisations.chatCommands.uses;
  return {
    create: (input, signal) => create.v1(input, { signal }),
    settle: (input, signal) => settle.v1(input, { signal })
  };
}

/** A command, as its uses are kept and told: by its key, and by the word the studio API is told it was used by. */
export interface UsedCommand {
  key: string;
  /** Its name, as the studio API is told it: a standard command's own name, whichever of its words was used. */
  name: string;
}

/** What a standard command's key starts with: an own command's is its ID, which never does. */
const STANDARD_KEY = 'standard:';

/** The key a use of a standard command is kept by: by camera, from its first word, for one that acts on a camera. */
export function keyOf(command: ListenedStandardCommand, words: readonly string[]): string {
  if (command.target === 'show') return `${STANDARD_KEY}${command.name}`;
  const [camera = ''] = words;
  const cameraName = chatName(camera);
  return `${STANDARD_KEY}${command.name}:${cameraName}`;
}

/** The command a key is kept by, while the spec has it. */
function commandOf(spec: ChatSpec, key: string): UsedCommand | undefined {
  if (!key.startsWith(STANDARD_KEY)) {
    const own = spec.commands.find(candidate => candidate.id === key);
    return own === undefined ? undefined : { key, name: own.name };
  }
  const [name] = key.slice(STANDARD_KEY.length).split(':');
  const standard = spec.standard.find(candidate => candidate.name === name);
  return standard === undefined ? undefined : { key, name: standard.name };
}

/** A use of a command, as heard: enough to tell the studio API of it. */
export interface Use {
  messageId: string;
  channelId: string;
  user: ChatUser;
  words: string[];
  /** Epoch milliseconds: when it was heard. */
  at: number;
}

/** A tell of a use to the studio API, and what came of it is reported under. */
export interface Tell {
  /** Its number, by which its answer is told from a stale one. */
  seq: number;
  organisationId: string;
  key: string;
  /** The command's name: told to the studio API, and logged by. */
  name: string;
  /** Epoch milliseconds: when it was told. */
  sentAt: number;
}

interface Ready {
  status: 'ready';
  /** Epoch milliseconds: when the quiet after its last tell ends. */
  quietUntil: number;
}

interface Spaced {
  status: 'spaced';
  /** Epoch milliseconds: when the quiet ends, and the use is told. */
  until: number;
  use: Use;
}

interface InFlight {
  tell: Tell;
  /** The latest use heard since it was told, told in turn once it is answered: null when none was. */
  waiting: Use | null;
}

interface Telling extends InFlight {
  status: 'telling';
}

interface Carrying extends InFlight {
  status: 'carrying';
  receipt: string;
  /** Epoch milliseconds: when the plan said the command's rest ends, or null. */
  restsUntil: number | null;
}

interface Settling extends InFlight {
  status: 'settling';
  receipt: string;
  restsUntil: number | null;
  result: CarryResult;
}

interface Resting {
  status: 'resting';
  /** Epoch milliseconds: when the studio API said its rest ends. */
  until: number;
  quietUntil: number;
}

/** What a command is doing with the uses heard of it. */
export type CommandUse = Ready | Spaced | Telling | Carrying | Settling | Resting;

interface Stopped {
  status: 'stopped';
}

interface Listening {
  status: 'listening';
  spec: ChatSpec;
}

interface Disposed {
  status: 'disposed';
}

/** Whether chat is listened to for the spec's commands. */
export type Life = Stopped | Listening | Disposed;

/** What each command with something in hand is doing, by its key. */
export type Commands = Record<string, CommandUse>;

export interface UsesContext {
  life: Life;
  /** The last number given to a tell. */
  seq: number;
  /** How many uses were told to the studio API, for good. */
  triggered: number;
  /** ISO 8601: when a use was last told. */
  lastTriggeredAt: string | null;
  /** Each command with something in hand, by its key: one that isn't here is ready. */
  commands: Commands;
}

interface AtEvent {
  /** Epoch milliseconds. */
  at: number;
}

interface AppliedEvent extends AtEvent {
  spec: ChatSpec;
}

interface HeardEvent extends AtEvent {
  message: ChatMessage;
}

interface CommandEvent extends AtEvent {
  key: string;
}

interface TellEvent extends CommandEvent {
  /** The tell it reports on. */
  seq: number;
}

interface AnsweredEvent extends TellEvent {
  answer: UseAnswer;
}

interface FailedEvent extends TellEvent {
  error: unknown;
}

interface CarriedEvent extends TellEvent {
  result: CarryResult;
}

interface SettledEvent extends TellEvent {
  answer: SettleAnswer;
}

export type UsesEvents = {
  /** Listen for this spec's commands from now on. */
  applied: AppliedEvent;
  /** Listen for none: uses waiting are dropped, those in flight seen through. */
  stopped: AtEvent;
  /** Listen for none, for good: everything in hand is dropped. */
  disposed: AtEvent;
  /** A message in one of the channels, which may use a command. */
  heard: HeardEvent;
  /** A command's quiet came to its end, with a use waiting for it. */
  gapEnded: CommandEvent;
  /** A command's rest came to its end. */
  restEnded: CommandEvent;
  /** The studio API answered a tell. */
  answered: AnsweredEvent;
  /** The studio API didn't answer a tell, or not in time. */
  unanswered: FailedEvent;
  /** A planned use's camera commands were carried, as far as they went. */
  carried: CarriedEvent;
  /** The studio API took a planned use's settlement. */
  settled: SettledEvent;
  /** The studio API didn't take a settlement, or not in time. */
  unsettled: FailedEvent;
};

/** The uses emit nothing. */
type UsesEmitted = Record<never, never>;

export type UsesStore = Store<UsesContext, UsesEvents, ExtractEvents<UsesEmitted>>;

type Enqueue = EnqueueObject<UsesContext, ExtractEvents<UsesEmitted>, UsesEvents>;

/** What the uses' effects reach: the clock, the studio API, the courier, and what calls them all off. */
export interface UsesIO {
  time: Time;
  studio: ChatStudio;
  courier: Courier;
  /** Aborts everything in flight, when the runtime is disposed of. */
  ends: AbortSignal;
}

const STOPPED: Life = { status: 'stopped' };
const DISPOSED: Life = { status: 'disposed' };

export function initialUses(): UsesContext {
  return { life: STOPPED, seq: 0, triggered: 0, lastTriggeredAt: null, commands: {} };
}

/** Whether a command has a tell in flight. */
export function inFlight(use: CommandUse | undefined): use is Telling | Carrying | Settling {
  return use?.status === 'telling' || use?.status === 'carrying' || use?.status === 'settling';
}

/** The context with what the command is doing replaced: forgotten, when it is undefined. */
function withCommand(context: UsesContext, key: string, use: CommandUse | undefined): UsesContext {
  const commands = { ...context.commands };
  if (use === undefined) delete commands[key];
  else commands[key] = use;
  return { ...context, commands };
}

/** A command ready for its next use, as of `at`: not kept at all once its quiet is over. */
function quietOf(quietUntil: number, at: number): Ready | undefined {
  return quietUntil > at ? { status: 'ready', quietUntil } : undefined;
}

/** The command and channel a use names, while they are both in the spec being listened for. */
function listenedFor(context: UsesContext, key: string, channelId: string) {
  const { life } = context;
  if (life.status !== 'listening') return undefined;
  const { spec } = life;
  const command = commandOf(spec, key);
  const channel = spec.channels.find(candidate => candidate.channelId === channelId);
  if (command === undefined || channel === undefined) return undefined;
  return { spec, command };
}

/** The use a message makes of one of the spec's commands, in one of its channels, by someone in its audience. */
export function useOf(spec: ChatSpec, message: ChatMessage, at: number) {
  // A command is `!` and its word, in a channel of the spec's, from someone in its audience.
  if (!message.text.startsWith('!')) return undefined;
  const [word = '', ...rest] = message.text.slice(1).trim().split(/\s+/u);
  const name = word.toLowerCase();
  const words = rest.slice(0, MAX_WORDS).map(text => text.slice(0, MAX_WORD_LENGTH));
  const listened = listenedOf(spec, name, words);
  const channel = spec.channels.find(candidate => candidate.login.toLowerCase() === message.channel);
  if (listened === undefined || channel === undefined) return undefined;
  if (!inAudience(listened.audience, message.user.roles)) return undefined;
  const command: UsedCommand = { key: listened.key, name: listened.name };
  const use: Use = { messageId: message.id, channelId: channel.channelId, user: message.user, words, at };
  return { command, use };
}

/**
 * The spec's command a word is, with who may use it: an own command by its name, a standard one by any of its words.
 */
function listenedOf(spec: ChatSpec, word: string, words: readonly string[]) {
  const own = spec.commands.find(candidate => candidate.name === word);
  if (own !== undefined) return { key: own.id, name: own.name, audience: own.audience };
  const standard = spec.standard.find(candidate => candidate.words.includes(word));
  if (standard === undefined) return undefined;
  const key = keyOf(standard, words);
  return { key, name: standard.name, audience: standard.audience };
}

/** Epoch milliseconds, from the studio API's ISO 8601: null for null, or for what isn't a time. */
function epochOf(iso: string | null): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * What each command is to be woken for, and when (epoch milliseconds), as its state says: by `gap:` or `rest:` and its
 * key.
 */
export function alarmsOf(context: UsesContext): Map<string, number> {
  const alarms = new Map<string, number>();
  for (const [key, use] of Object.entries(context.commands)) {
    if (use.status === 'spaced') alarms.set(`gap:${key}`, use.until);
    if (use.status === 'resting') alarms.set(`rest:${key}`, use.until);
  }
  return alarms;
}

/**
 * What a command keeps of what it is doing when a new spec is applied: everything, rests and quiets too, even for a
 * command the spec no longer has, in case it comes back; only a use waiting on a command or channel the spec no
 * longer has is dropped, and a ready command whose quiet is over isn't kept at all.
 */
function keptOnApply(key: string, use: CommandUse, spec: ChatSpec, at: number): CommandUse | undefined {
  const heardHere = (heard: Use | null) =>
    heard !== null &&
    commandOf(spec, key) !== undefined &&
    spec.channels.some(channel => channel.channelId === heard.channelId);
  if (inFlight(use)) return { ...use, waiting: heardHere(use.waiting) ? use.waiting : null };
  if (use.status === 'spaced') return heardHere(use.use) ? use : quietOf(use.until, at);
  if (use.status === 'ready') return quietOf(use.quietUntil, at);
  return use;
}

/**
 * What a command keeps of what it is doing when nothing is listened for any more: what is in flight, to see it
 * through, and its quiet, which needs no timer. Nothing waits, and nothing rests.
 */
function keptOnStop(use: CommandUse, at: number): CommandUse | undefined {
  if (inFlight(use)) return { ...use, waiting: null };
  if (use.status === 'spaced') return quietOf(use.until, at);
  return quietOf(use.quietUntil, at);
}

/** Each command's use, as `kept` keeps it: those it keeps nothing of are forgotten. */
function keeping(commands: Commands, kept: (key: string, use: CommandUse) => CommandUse | undefined) {
  const next: Commands = {};
  for (const [key, use] of Object.entries(commands)) {
    const keptUse = kept(key, use);
    if (keptUse !== undefined) next[key] = keptUse;
  }
  return next;
}

/** The event an alarm of `alarmsOf` wakes the store with. */
export function ringOf(name: string, at: number) {
  const colon = name.indexOf(':');
  const key = name.slice(colon + 1);
  const type = name.slice(0, colon) === 'gap' ? 'gapEnded' : 'restEnded';
  return { type, key, at } as const;
}

/** Carry the commands in order until one isn't: what came of them. */
async function carryAll(courier: Courier, commands: CarriedCommand[], signal: AbortSignal): Promise<CarryResult> {
  for (const command of commands) {
    const result = await courier.carry(command, signal);
    if (result !== 'carried') return result;
  }
  return 'carried';
}

/** The uses' store, its effects reaching the studio API and the cameras through `io`. */
export function usesStore(io: UsesIO): UsesStore {
  const { time, studio, courier, ends } = io;

  /** Tell the studio API of the use, as the next tell by number: `answered` or `unanswered` says how it went. */
  function tell(context: UsesContext, spec: ChatSpec, command: UsedCommand, use: Use, at: number, enq: Enqueue) {
    const seq = context.seq + 1;
    const { organisationId } = spec;
    const { key, name } = command;
    const told: Tell = { seq, organisationId, key, name, sentAt: at };
    const input: UseInput = {
      id: organisationId,
      command: name,
      channelId: use.channelId,
      messageId: use.messageId,
      user: use.user,
      words: use.words
    };
    enq.effect(({ trigger }) => {
      const asked = within(time, TELL_TIMEOUT_MS, ends, signal => studio.create(input, signal));
      void asked.then(
        answer => {
          if (answer instanceof Error) trigger.unanswered({ key, seq, error: answer, at: time.now() });
          else trigger.answered({ key, seq, answer, at: time.now() });
        },
        error => trigger.unanswered({ key, seq, error, at: time.now() })
      );
    });
    const lastTriggeredAt = new Date(at).toISOString();
    const next = { ...context, seq, triggered: context.triggered + 1, lastTriggeredAt };
    return withCommand(next, key, { status: 'telling', tell: told, waiting: null });
  }

  /** A use of a command with nothing in flight: told now, or once the quiet after its last tell ends. */
  function admit(
    context: UsesContext,
    spec: ChatSpec,
    command: UsedCommand,
    use: Use,
    quietUntil: number,
    at: number,
    enq: Enqueue
  ) {
    if (at >= quietUntil) return tell(context, spec, command, use, at, enq);
    return withCommand(context, command.key, { status: 'spaced', until: quietUntil, use });
  }

  /**
   * What a command does once its tell is through, with when the studio API last said its rest ends: rest, tell the
   * use that waited, or be ready. While nothing is listened for it keeps only its quiet, and drops what waited.
   */
  function through(context: UsesContext, flight: InFlight, restsUntil: number | null, at: number, enq: Enqueue) {
    const { tell: told, waiting } = flight;
    const { key } = told;
    const quietUntil = told.sentAt + MIN_GAP_MS;
    const { life } = context;
    if (life.status === 'disposed') return withCommand(context, key, undefined);
    if (life.status === 'stopped') return withCommand(context, key, quietOf(quietUntil, at));
    if (restsUntil !== null && restsUntil > at) {
      return withCommand(context, key, { status: 'resting', until: restsUntil, quietUntil });
    }
    const found = waiting === null ? undefined : listenedFor(context, key, waiting.channelId);
    if (waiting === null || found === undefined) return withCommand(context, key, quietOf(quietUntil, at));
    return admit(context, found.spec, found.command, waiting, quietUntil, at, enq);
  }

  /**
   * A use of a command, as what the command is doing takes it: told now or once its quiet ends, waiting for the tell
   * in flight (the latest use only), or dropped while the command rests.
   */
  function heardOf(
    context: UsesContext,
    spec: ChatSpec,
    command: UsedCommand,
    use: Use,
    at: number,
    enq: Enqueue
  ): UsesContext {
    const current = context.commands[command.key];
    if (current === undefined) return admit(context, spec, command, use, 0, at, enq);
    switch (current.status) {
      case 'ready':
        return admit(context, spec, command, use, current.quietUntil, at, enq);
      case 'spaced':
        return withCommand(context, command.key, { ...current, use });
      case 'telling':
      case 'carrying':
      case 'settling':
        return withCommand(context, command.key, { ...current, waiting: use });
      case 'resting':
        // Resting, as the studio API said: dropped, unless the rest is over and its alarm not yet come.
        if (current.until > at) return context;
        return admit(context, spec, command, use, current.quietUntil, at, enq);
    }
  }

  return createStore<UsesContext, UsesEvents, UsesEmitted>({
    context: initialUses(),
    on: {
      applied: (context, event) => {
        if (context.life.status === 'disposed') return context;
        const { spec, at } = event;
        const commands = keeping(context.commands, (key, use) => keptOnApply(key, use, spec, at));
        return { ...context, life: { status: 'listening', spec }, commands };
      },
      stopped: (context, event) => {
        if (context.life.status !== 'listening') return context;
        const { at } = event;
        const commands = keeping(context.commands, (_key, use) => keptOnStop(use, at));
        return { ...context, life: STOPPED, commands };
      },
      disposed: context => ({ ...context, life: DISPOSED, commands: {} }),
      heard: (context, event, enq) => {
        const { life } = context;
        if (life.status !== 'listening') return context;
        const { spec } = life;
        const { at } = event;
        const used = useOf(spec, event.message, at);
        if (used === undefined) return context;
        const { command, use } = used;
        return heardOf(context, spec, command, use, at, enq);
      },
      gapEnded: (context, event, enq) => {
        // The use that waited out the quiet is told, if its command and channel are still listened for; a stale
        // alarm, rung before its time or after the use moved on, changes nothing.
        const { key, at } = event;
        const current = context.commands[key];
        if (current?.status !== 'spaced' || current.until > at) return context;
        const found = listenedFor(context, key, current.use.channelId);
        if (found === undefined) return withCommand(context, key, undefined);
        return tell(context, found.spec, found.command, current.use, at, enq);
      },
      restEnded: (context, event) => {
        const { key, at } = event;
        const current = context.commands[key];
        if (current?.status !== 'resting' || current.until > at) return context;
        return withCommand(context, key, quietOf(current.quietUntil, at));
      },
      answered: (context, event, enq) => {
        // Only the answer to the tell in flight counts. One that didn't plan anything is through, resting as it says;
        // a planned one is carried.
        const { key, seq, answer, at } = event;
        const current = context.commands[key];
        if (current?.status !== 'telling' || current.tell.seq !== seq) return context;
        const { tell: told } = current;
        const restsUntil = epochOf(answer.restsUntil);
        if (answer.status !== 'planned') {
          const { name } = told;
          const outcome = answer.status === 'notRun' ? answer.reason : 'ran';
          enq.effect(() => logger.debug('!{name} was used: {outcome}', { name, outcome }));
          return through(context, current, restsUntil, at, enq);
        }
        const { receipt, cameraCommands } = answer;
        enq.effect(({ trigger }) => {
          const carrying = within(time, CARRY_TIMEOUT_MS, ends, signal => carryAll(courier, cameraCommands, signal));
          void carrying.then(
            result => trigger.carried({ key, seq, result, at: time.now() }),
            () => trigger.carried({ key, seq, result: 'failed', at: time.now() })
          );
        });
        const carryingUse: Carrying = { ...current, status: 'carrying', receipt, restsUntil };
        return withCommand(context, key, carryingUse);
      },
      unanswered: (context, event, enq) => {
        const { key, seq, error, at } = event;
        const current = context.commands[key];
        if (current?.status !== 'telling' || current.tell.seq !== seq) return context;
        const { name } = current.tell;
        enq.effect(() => logger.error('Telling the studio !{name} was used failed: {error}', { name, error }));
        // Nothing was heard of its rest: the quiet alone spaces the next.
        return through(context, current, null, at, enq);
      },
      carried: (context, event, enq) => {
        const { key, seq, result } = event;
        const current = context.commands[key];
        if (current?.status !== 'carrying' || current.tell.seq !== seq) return context;
        // What the carrying came to is told to the studio API, which says so in chat and gives the turn back if the
        // camera didn't move: the command settles until it answers, or has had `SETTLE_TIMEOUT_MS` to.
        const { tell: told, receipt } = current;
        const { name, organisationId } = told;
        if (result !== 'carried') enq.effect(() => logger.warn('!{name} came to {result}', { name, result }));
        const input: SettleInput = { id: organisationId, receipt, result };
        enq.effect(({ trigger }) => {
          const settling = within(time, SETTLE_TIMEOUT_MS, ends, signal => studio.settle(input, signal));
          void settling.then(
            answer => {
              if (answer instanceof Error) trigger.unsettled({ key, seq, error: answer, at: time.now() });
              else trigger.settled({ key, seq, answer, at: time.now() });
            },
            error => trigger.unsettled({ key, seq, error, at: time.now() })
          );
        });
        return withCommand(context, key, { ...current, status: 'settling', result });
      },
      settled: (context, event, enq) => {
        const { key, seq, answer, at } = event;
        const current = context.commands[key];
        if (current?.status !== 'settling' || current.tell.seq !== seq) return context;
        const restsUntil = epochOf(answer.restsUntil);
        return through(context, current, restsUntil, at, enq);
      },
      unsettled: (context, event, enq) => {
        const { key, seq, error, at } = event;
        const current = context.commands[key];
        if (current?.status !== 'settling' || current.tell.seq !== seq) return context;
        const { name } = current.tell;
        enq.effect(() => logger.error('Settling a use of !{name} failed: {error}', { name, error }));
        // Its turn wasn't given back, as far as is known: it rests as the plan said.
        return through(context, current, current.restsUntil, at, enq);
      }
    }
  });
}
