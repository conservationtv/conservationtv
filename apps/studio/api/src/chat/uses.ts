import type { CameraCommand } from '@conservationtv/cameras';
import { type CarryResult, type ChatAudience, type ChatCommandReason, standardCommand } from '@conservationtv/chat';
import { type AgentReference, commandGrant, selectAgentIdentity, selectServingAgents } from '../cameras/grants.ts';
import { freshTwitchCredentials, twitchSendChatMessage } from '../channels/twitch.ts';
import { transaction } from '../db/transaction.ts';
import { useEnvironment } from '../env/env.ts';
import { ApiFailure } from '../errors.ts';
import type { AuthenticatedDevice } from '../middleware/device.ts';
import { getChannelCredentials, saveChannelCredentials } from '../services/channels.ts';
import {
  type Claim,
  claimChatCommand,
  claimStandardTurn,
  type ClaimedTurn,
  giveBackChatCommand,
  giveBackStandardTurn,
  selectCommandRest,
  selectNamedCameras,
  selectStandardRest,
  selectStandardUse,
  selectUsedCommand,
  selectUsedCommandByName
} from '../services/chat-commands.ts';
import { selectDeviceOutput, selectOutputChatChannelIds } from '../services/outputs.ts';
import { updateShowControls, updateShowStream } from '../services/shows.ts';
import { readShowFacts, writeLineup } from '../shows/lineup.ts';
import {
  decideUse,
  type Move,
  restsUntil,
  settledReply,
  type ShowCommand,
  toldWhy,
  type Turn,
  type UsedCommand,
  type UseFacts
} from './decide.ts';
import { type ReceiptUse, signReceipt } from './receipts.ts';

// Carrying a use of a chat command through this API (src/chat/decide.ts sets out the steps): reading what it is decided
// from, taking its turn, making the change it decided on, signing grants for the camera commands it plans, and later
// settling it. The operations that take a use (src/routes/chat-uses.ts, and `organisations.chatCommands.trigger` for
// agents built before the standard commands) run it all as trusted code, once the device is known to be the agent of
// an output whose chat the channel's is.

/** Which command a use is of: an own command by its ID, or any by the word it was used by. */
export type UsedReference = ById | ByWord;

export interface ById {
  commandId: string;
}

export interface ByWord {
  word: string;
}

/** Who used a command, as the channel's platform says. */
export interface ChatUser {
  id: string;
  name: string;
  roles: ChatAudience[];
}

/** One use of a command, as the agent that heard it tells it. */
export interface Trigger {
  channelId: string;
  messageId: string;
  user: ChatUser;
  words: string[];
}

/** A command for a camera, resolved from a chat command: where to send it, and what admits it there. */
export interface PlannedCameraCommand {
  agent: AgentReference;
  cameraId: string;
  command: CameraCommand;
  grant: string;
  expiresAt: string;
}

/** Nothing ran, and the use spent nothing: why, and when the command's rest ends (ISO 8601) while it rests. */
export interface NotRunOutcome {
  status: 'notRun';
  reason: ChatCommandReason;
  /** What this API had to say about it, if anything. */
  reply: string | null;
  restsUntil: string | null;
}

/** It ran, and finished here: a reply, said in chat by this API. */
export interface RanOutcome {
  status: 'ran';
  reply: string;
  restsUntil: string | null;
}

/** It ran, and the agent that heard it has camera commands to carry out, then settles it with the receipt. */
export interface PlannedOutcome {
  status: 'planned';
  restsUntil: string | null;
  cameraCommands: PlannedCameraCommand[];
  receipt: string;
}

/** What using a command came to, before anything is said in chat. */
export type Outcome = NotRunOutcome | RanOutcome | PlannedOutcome;

/** What using a command came to, and the show it changed, to poke once that has committed. */
export interface Used {
  outcome: Outcome;
  changedShowId?: string;
}

const iso = (date: Date | null) => date?.toISOString() ?? null;

/**
 * Refuses the device unless it is the agent of an output whose chat the channel's is: one it goes out to, or one of its
 * control channels (`forbidden`). Only that agent hears the channel's chat for this API.
 */
export async function requireOutputAgent(device: AuthenticatedDevice, organisationId: string, channelId: string) {
  const output = await selectDeviceOutput(device.id);
  if (output === undefined || output.organisationId !== organisationId) throw new ApiFailure('forbidden');
  const channelIds = await selectOutputChatChannelIds(output.outputId);
  if (!channelIds.includes(channelId)) throw new ApiFailure('forbidden');
}

/** The command a use is of, as it is used: an own command (by ID or word), or a standard one (by its name or alias). */
async function usedCommand(organisationId: string, reference: UsedReference): Promise<UsedCommand | undefined> {
  if ('commandId' in reference) {
    const own = await selectUsedCommand(organisationId, reference.commandId);
    return own === undefined ? undefined : { kind: 'own', ...own };
  }
  const standard = standardCommand(reference.word);
  if (standard !== undefined) {
    const use = await selectStandardUse(organisationId, standard.name);
    return use === undefined ? undefined : { kind: 'standard', ...use };
  }
  const own = await selectUsedCommandByName(organisationId, reference.word);
  return own === undefined ? undefined : { kind: 'own', ...own };
}

/**
 * Everything the use is decided from (src/chat/decide.ts): for a standard command, the cameras, the agents that reach
 * them for a camera command, and the show the device's output follows with what it is resolved from. A layout or audio
 * command reads the show holding its row until the transaction ends, so what the use is decided against is what it
 * writes to.
 */
async function useFacts(device: AuthenticatedDevice, command: UsedCommand | undefined, trigger: Trigger) {
  const environment = useEnvironment();
  const now = new Date(environment.clock());
  const facts: UseFacts = {
    command,
    roles: trigger.user.roles,
    words: trigger.words,
    cameras: [],
    servingAgents: new Map(),
    show: undefined,
    now
  };
  if (command?.kind !== 'standard') return facts;
  const cameras = await selectNamedCameras(device.organisationId);
  const isCamera = command.target === 'camera';
  const servingAgents = isCamera ? await selectServingAgents(device.organisationId) : new Map<string, AgentReference>();
  const output = await selectDeviceOutput(device.id);
  if (output?.control !== 'show' || output.showId === null) return { ...facts, cameras, servingAgents };
  // A camera command reads the show only to count positions in, and changes nothing of it: it holds no row.
  const location = { showId: output.showId, organisationId: device.organisationId };
  const show = await readShowFacts(location, !isCamera);
  return { ...facts, cameras, servingAgents, show };
}

/** Make the change a layout or audio command decided on, in the transaction that holds the show's row. */
async function changeShow({ show, change }: ShowCommand): Promise<void> {
  const { id, organisationId } = show.show;
  switch (change.kind) {
    case 'takeover':
      await updateShowControls(organisationId, id, { takeoverStreamId: change.streamId, takeoverLive: change.live });
      return;
    case 'ranks':
      // The ranks were decided against the lineup normalised: that is written first, then the change.
      await writeLineup(show, change.changes);
      return;
    case 'slots':
      await updateShowControls(organisationId, id, { slots: change.slots });
      return;
    case 'mix':
      for (const { streamId, ...mix } of change.mixes) await updateShowStream(organisationId, id, streamId, mix);
      if (change.showMuted !== undefined) await updateShowControls(organisationId, id, { muted: change.showMuted });
  }
}

/** Take the turn a use decided on: undefined when another use took it since the facts were read. */
function claim(organisationId: string, turn: Turn, cooldownSeconds: number, now: Date) {
  if (turn.kind === 'own') return claimChatCommand(turn.commandId, now);
  return claimStandardTurn(organisationId, turn, cooldownSeconds, now);
}

/** When the turn's command last ran there, and how long it rests after: none when it is gone or off. */
function restOf(organisationId: string, turn: Turn) {
  if (turn.kind === 'own') return selectCommandRest(turn.commandId);
  return selectStandardRest(organisationId, turn);
}

/**
 * What using the command comes to, by trusted code once the device is known to be the channel's agent: decided from
 * what is read, then, for a use that runs, its turn taken, and the show changed or grants signed for the camera.
 */
export async function useCommand(
  device: AuthenticatedDevice,
  reference: UsedReference,
  trigger: Trigger
): Promise<Used> {
  const { organisationId } = device;
  await requireOutputAgent(device, organisationId, trigger.channelId);
  const command = await usedCommand(organisationId, reference);
  const facts = await useFacts(device, command, trigger);
  const decision = decideUse(facts);
  if (decision.kind === 'notRun') {
    const { reason, reply } = decision;
    return { outcome: { status: 'notRun', reason, reply, restsUntil: iso(decision.restsUntil) } };
  }
  const { now } = facts;
  const { turn, effect } = decision;
  const claimed = await claim(organisationId, turn, command!.cooldownSeconds, now);
  if (claimed === undefined) {
    // Another use took the turn since the facts were read: the command rests from that one.
    const rest = await restOf(organisationId, turn);
    const until = rest === undefined ? null : restsUntil(rest, now);
    return { outcome: { status: 'notRun', reason: 'resting', reply: null, restsUntil: iso(until) } };
  }
  const rest = restsUntil({ cooldownSeconds: claimed.cooldownSeconds, triggeredAt: claimed.claimedAt }, now);
  const until = iso(rest);
  if (effect.kind === 'say') return { outcome: { status: 'ran', reply: effect.text, restsUntil: until } };
  if (effect.kind === 'show') {
    await changeShow(effect);
    const outcome: RanOutcome = { status: 'ran', reply: effect.text, restsUntil: until };
    return { outcome, changedShowId: effect.show.show.id };
  }
  return { outcome: await planMove(device, turn, trigger, effect, claimed, until) };
}

/** The planned move: a grant for exactly each of its commands, for this device, and the receipt to settle it with. */
async function planMove(
  device: AuthenticatedDevice,
  turn: Turn,
  trigger: Trigger,
  move: Move,
  claimed: ClaimedTurn,
  until: string | null
): Promise<PlannedOutcome> {
  const { agent, camera, commands } = move;
  const identity = await selectAgentIdentity(agent.id);
  // Read in this transaction a moment ago: gone only if the agent was deleted since, which rolls the claim back.
  if (identity === undefined) throw new ApiFailure('camera_unavailable');
  const cameraCommands: PlannedCameraCommand[] = [];
  for (const command of commands) {
    const signed = await commandGrant(identity, device.publicId, camera.id, command, 'automation');
    cameraCommands.push({ agent, cameraId: camera.id, command, ...signed });
  }
  const receipt = await signReceipt(device.id, {
    turn,
    channelId: trigger.channelId,
    messageId: trigger.messageId,
    camera: camera.name,
    carried: move.text,
    claimedAt: claimed.claimedAt.toISOString(),
    previous: iso(claimed.previous),
    told: toldWhy(trigger.user.roles)
  });
  return { status: 'planned', restsUntil: until, cameraCommands, receipt };
}

/**
 * Settle a planned use with what came of it, by trusted code once the device is known to be the channel's agent: when
 * the camera didn't move, the turn is given back. What to say in chat, where, and the command's rest there after.
 */
export async function settleUse(device: AuthenticatedDevice, use: ReceiptUse, result: CarryResult) {
  const { organisationId } = device;
  await requireOutputAgent(device, organisationId, use.channelId);
  const { turn } = use;
  if (result !== 'carried') {
    const claimed: Claim = {
      claimedAt: new Date(use.claimedAt),
      previous: use.previous === null ? null : new Date(use.previous)
    };
    if (turn.kind === 'own') await giveBackChatCommand(turn.commandId, claimed);
    else await giveBackStandardTurn(organisationId, turn, claimed);
  }
  const environment = useEnvironment();
  const now = new Date(environment.clock());
  const rest = await restOf(organisationId, turn);
  const until = rest === undefined ? null : restsUntil(rest, now);
  const reply = settledReply(result, use.camera, use.carried, use.told);
  return { reply, restsUntil: iso(until) };
}

/**
 * Say the reply in the channel's chat, as its broadcaster, in the device's own request session: only a
 * `channelBroadcaster` reads the channel's tokens. False when it could not be said: the channel is not a Twitch
 * connection, lacks the scope, or Twitch refused. A reply never fails the command it answers.
 */
export async function say(organisationId: string, channelId: string, text: string, replyTo: string) {
  try {
    // Twitch connections alone can be spoken through; their tokens are refreshed, and kept, when about to expire.
    const channel = await transaction(() => getChannelCredentials(organisationId, channelId));
    if (channel?.credentials.kind !== 'twitch') return false;
    const fresh = await freshTwitchCredentials(channel.credentials);
    if (fresh !== channel.credentials)
      await transaction(() => saveChannelCredentials(organisationId, channelId, fresh));
    return await twitchSendChatMessage(fresh, channel.externalId ?? '', { text, replyTo });
  } catch (error) {
    console.warn(JSON.stringify({ event: 'chat_reply_failed', channelId, error: String(error) }));
    return false;
  }
}
