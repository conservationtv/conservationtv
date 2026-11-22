import { type CameraCommand } from '@conservationtv/cameras';
import { type CarryResult, CarryResultSchema, ChatAudienceSchema, type ChatCommandReason } from '@conservationtv/chat';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { audited } from '../audit/audit.ts';
import { type AgentReference, commandGrant, selectAgentIdentity, selectServingAgents } from '../cameras/grants.ts';
import { ChatCommandActionSchema, ChatCommandNameSchema } from '../chat/commands.ts';
import { decideUse, type Move, restsUntil, settledReply, toldWhy, type UseFacts } from '../chat/decide.ts';
import { type ReceiptUse, signReceipt, verifyReceipt } from '../chat/receipts.ts';
import { freshTwitchCredentials, twitchSendChatMessage } from '../channels/twitch.ts';
import { transaction, trustedTransaction } from '../db/transaction.ts';
import { useEnvironment } from '../env/env.ts';
import { ApiFailure } from '../errors.ts';
import { type AuthenticatedDevice, requireDevice, useDevice } from '../middleware/device.ts';
import { requirePrincipal } from '../middleware/principal.ts';
import { getChannelCredentials, saveChannelCredentials } from '../services/channels.ts';
import {
  type Claim,
  claimChatCommand,
  createChatCommand,
  deleteChatCommand,
  getChatCommand,
  giveBackChatCommand,
  listChatCommands,
  selectCommandRest,
  selectNamedCameras,
  selectUsedCommand,
  updateChatCommand
} from '../services/chat-commands.ts';
import { selectDeviceOutput, selectOutputPlan } from '../services/outputs.ts';
import {
  commandNameTaken,
  forbidden,
  invalidReceipt,
  invalidRequest,
  invalidSignature,
  notFound,
  notOutputAgent,
  operationVersion,
  unauthenticated,
  unavailable,
  validator,
  versionMismatch
} from './openapi.ts';

const OrganisationParamsSchema = z.object({ id: z.uuid().describe('The organisation.') });
export type OrganisationParams = z.output<typeof OrganisationParamsSchema>;
const CommandParamsSchema = OrganisationParamsSchema.extend({ commandId: z.uuid().describe('The command.') });
export type CommandParams = z.output<typeof CommandParamsSchema>;

const CooldownSchema = z
  .int()
  .min(0)
  .max(86_400)
  .describe('How many seconds the command rests after it runs, whoever used it.');
export type Cooldown = z.output<typeof CooldownSchema>;

const NewCommandSchema = z.strictObject({
  name: ChatCommandNameSchema,
  action: ChatCommandActionSchema,
  audience: ChatAudienceSchema.default('moderator'),
  cooldownSeconds: CooldownSchema.default(5),
  enabled: z.boolean().default(true)
});
export type NewCommand = z.output<typeof NewCommandSchema>;

/** One use of a command, as the agent that heard it tells it. */
const TriggerSchema = z.strictObject({
  channelId: z.uuid().describe('The channel it was used in.'),
  messageId: z.string().min(1).max(120).describe("The chat message's ID on its platform, to answer it."),
  user: z
    .strictObject({
      id: z.string().min(1).max(120),
      name: z.string().min(1).max(120),
      roles: z.array(ChatAudienceSchema).max(8).describe('What they are in the channel, as its platform says.')
    })
    .describe('Who used it.'),
  words: z.array(z.string().min(1).max(60)).max(8).describe('The words that followed the command, in order.')
});
export type Trigger = z.output<typeof TriggerSchema>;

/** What came of carrying out a planned use, as the agent that carried it says. */
const SettlementSchema = z.strictObject({
  receipt: z.string().min(1).max(4096).describe('The `receipt` the use was planned with.'),
  result: CarryResultSchema
});
export type Settlement = z.output<typeof SettlementSchema>;

/** A command for a camera, resolved from a chat command: where to send it, and what admits it there. */
interface PlannedCameraCommand {
  agent: AgentReference;
  cameraId: string;
  command: CameraCommand;
  grant: string;
  expiresAt: string;
}

/** Nothing ran, and the use spent nothing: why, and when the command's rest ends (ISO 8601) while it rests. */
interface NotRunOutcome {
  status: 'notRun';
  reason: ChatCommandReason;
  /** What this API had to say about it, if anything. */
  reply: string | null;
  restsUntil: string | null;
}

/** It ran, and finished here: a reply, said in chat by this API. */
interface RanOutcome {
  status: 'ran';
  reply: string;
  restsUntil: string | null;
}

/** It ran, and the agent that heard it has camera commands to carry out, then settles it with the receipt. */
interface PlannedOutcome {
  status: 'planned';
  restsUntil: string | null;
  cameraCommands: PlannedCameraCommand[];
  receipt: string;
}

/** What using a command came to, before anything is said in chat. */
type Outcome = NotRunOutcome | RanOutcome | PlannedOutcome;

const iso = (date: Date | null) => date?.toISOString() ?? null;

/**
 * Refuses the device unless it is the agent of an output that goes out to the channel: `forbidden`. Only that agent
 * hears the channel's chat for this API.
 */
async function requireOutputAgent(device: AuthenticatedDevice, organisationId: string, channelId: string) {
  const output = await selectDeviceOutput(device.id);
  if (output === undefined || output.organisationId !== organisationId) throw new ApiFailure('forbidden');
  const plan = await selectOutputPlan(output.outputId);
  const forwarded = plan?.forwards.some(forward => forward.channelId === channelId) ?? false;
  if (!forwarded) throw new ApiFailure('forbidden');
}

/**
 * Everything the use is decided from (src/chat/decide.ts): the cameras and the agents that reach them only for a
 * command that moves one.
 */
async function useFacts(device: AuthenticatedDevice, commandId: string, trigger: Trigger): Promise<UseFacts> {
  const environment = useEnvironment();
  const now = new Date(environment.clock());
  const command = await selectUsedCommand(device.organisationId, commandId);
  const facts: UseFacts = {
    command,
    roles: trigger.user.roles,
    words: trigger.words,
    cameras: [],
    servingAgents: new Map(),
    now
  };
  if (command?.action.kind !== 'cameraPreset') return facts;
  const cameras = await selectNamedCameras(device.organisationId);
  const servingAgents = await selectServingAgents(device.organisationId);
  return { ...facts, cameras, servingAgents };
}

/**
 * What using the command comes to, by trusted code once the device is known to be the channel's agent: decided from
 * what is read, then, for a use that runs, its turn taken, and a grant signed for the move it plans.
 */
async function useCommand(device: AuthenticatedDevice, commandId: string, trigger: Trigger): Promise<Outcome> {
  await requireOutputAgent(device, device.organisationId, trigger.channelId);
  const facts = await useFacts(device, commandId, trigger);
  const decision = decideUse(facts);
  if (decision.kind === 'notRun') {
    const { reason, reply } = decision;
    return { status: 'notRun', reason, reply, restsUntil: iso(decision.restsUntil) };
  }
  const { now } = facts;
  const claim = await claimChatCommand(commandId, now);
  if (claim === undefined) {
    // Another use took the turn since the facts were read: the command rests from that one.
    const rest = await selectCommandRest(commandId);
    const until = rest === undefined ? null : restsUntil(rest, now);
    return { status: 'notRun', reason: 'resting', reply: null, restsUntil: iso(until) };
  }
  const rest = restsUntil({ cooldownSeconds: claim.cooldownSeconds, triggeredAt: claim.claimedAt }, now);
  const until = iso(rest);
  if (decision.kind === 'reply') return { status: 'ran', reply: decision.text, restsUntil: until };
  return planMove(device, commandId, trigger, decision, claim, until);
}

/** The planned move: a grant for exactly it, for this device, and the receipt to settle the use with. */
async function planMove(
  device: AuthenticatedDevice,
  commandId: string,
  trigger: Trigger,
  move: Move,
  claim: Claim,
  until: string | null
): Promise<PlannedOutcome> {
  const { agent, camera, command } = move;
  const identity = await selectAgentIdentity(agent.id);
  // Read in this transaction a moment ago: gone only if the agent was deleted since, which rolls the claim back.
  if (identity === undefined) throw new ApiFailure('camera_unavailable');
  const signed = await commandGrant(identity, device.publicId, camera.id, command, 'automation');
  const receipt = await signReceipt(device.id, {
    commandId,
    channelId: trigger.channelId,
    messageId: trigger.messageId,
    camera: camera.name,
    preset: move.preset.name,
    claimedAt: claim.claimedAt.toISOString(),
    previous: iso(claim.previous),
    told: toldWhy(trigger.user.roles)
  });
  const planned: PlannedCameraCommand = { agent, cameraId: camera.id, command, ...signed };
  return { status: 'planned', restsUntil: until, cameraCommands: [planned], receipt };
}

/**
 * Settle a planned use with what came of it, by trusted code once the device is known to be the channel's agent: when
 * the camera didn't move, the command's turn is given back. What to say in chat, where, and the command's rest after.
 */
async function settleUse(device: AuthenticatedDevice, use: ReceiptUse, result: CarryResult) {
  await requireOutputAgent(device, device.organisationId, use.channelId);
  if (result !== 'carried') {
    const claim: Claim = {
      claimedAt: new Date(use.claimedAt),
      previous: use.previous === null ? null : new Date(use.previous)
    };
    await giveBackChatCommand(use.commandId, claim);
  }
  const environment = useEnvironment();
  const now = new Date(environment.clock());
  const rest = await selectCommandRest(use.commandId);
  const until = rest === undefined ? null : restsUntil(rest, now);
  const reply = settledReply(result, use.camera, use.preset, use.told);
  return { reply, restsUntil: iso(until) };
}

/**
 * Say the reply in the channel's chat, as its broadcaster, in the device's own request session: only a
 * `channelBroadcaster` reads the channel's tokens. False when it could not be said: the channel is not a Twitch
 * connection, lacks the scope, or Twitch refused. A reply never fails the command it answers.
 */
async function say(organisationId: string, channelId: string, text: string, replyTo: string) {
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

// An organisation's chat commands: members read them, administrators manage them, and the agent of an output that goes
// out to a channel says when one is used there (`trigger`), and what came of carrying out the camera commands a use was
// planned to (`settle`). The agent only listens and carries: whether a command runs, what it does, and what is said in
// chat, is decided here each time, in the order src/chat/decide.ts sets out.
export default new Hono()
  .get(
    '/',
    describeRoute({
      operationId: 'organisations.chatCommands.list',
      ...operationVersion(1),
      summary: "List an organisation's chat commands",
      description: 'Empty for organisations you are not a member of.',
      responses: {
        200: { description: 'The commands, oldest first' },
        400: invalidRequest,
        401: unauthenticated,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', OrganisationParamsSchema),
    async c => {
      const { id } = c.req.valid('param');
      const rows = await transaction(() => listChatCommands(id));
      c.header('Cache-Control', 'no-store');
      return c.json({ commands: rows }, 200);
    }
  )
  .post(
    '/',
    describeRoute({
      operationId: 'organisations.chatCommands.create',
      ...operationVersion(1),
      summary: 'Add a chat command',
      description:
        "Administrators only. A command is the word viewers type after `!` in the chat of the organisation's channels, who may use it (`audience`, moderators unless said), how long it rests after it runs (`cooldownSeconds`, 5 unless said), and the one thing it does (`action`). The agents of outputs that go out to Twitch channels listen for it from their next configuration. `conflict` (409) when the organisation has a command used by that word.",
      responses: {
        201: { description: 'The new command' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        409: commandNameTaken,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    audited('configuration'),
    validator('param', OrganisationParamsSchema),
    validator('json', NewCommandSchema),
    async c => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const row = await transaction(() => createChatCommand(id, body));
      c.header('Cache-Control', 'no-store');
      return c.json(row, 201);
    }
  )
  .get(
    '/:commandId',
    describeRoute({
      operationId: 'organisations.chatCommands.get',
      ...operationVersion(1),
      summary: 'Read a chat command',
      responses: {
        200: { description: 'The command' },
        400: invalidRequest,
        401: unauthenticated,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', CommandParamsSchema),
    async c => {
      const { id, commandId } = c.req.valid('param');
      const row = await transaction(() => getChatCommand(id, commandId));
      if (!row) throw new ApiFailure('not_found');
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .patch(
    '/:commandId',
    describeRoute({
      operationId: 'organisations.chatCommands.update',
      ...operationVersion(1),
      summary: 'Update a chat command',
      description: 'Administrators only. Changes the fields given; its `action` is replaced whole.',
      responses: {
        200: { description: 'The updated command' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        409: commandNameTaken,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    audited('configuration'),
    validator('param', CommandParamsSchema),
    validator(
      'json',
      z
        .strictObject({
          name: ChatCommandNameSchema.optional(),
          action: ChatCommandActionSchema.optional(),
          audience: ChatAudienceSchema.optional(),
          cooldownSeconds: CooldownSchema.optional(),
          enabled: z.boolean().optional()
        })
        .refine(changes => Object.keys(changes).length > 0, 'Provide at least one field to change')
    ),
    async c => {
      const { id, commandId } = c.req.valid('param');
      const body = c.req.valid('json');
      const row = await transaction(() => updateChatCommand(id, commandId, body));
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .delete(
    '/:commandId',
    describeRoute({
      operationId: 'organisations.chatCommands.delete',
      ...operationVersion(1),
      summary: 'Remove a chat command',
      description: 'Administrators only.',
      responses: {
        204: { description: 'Removed' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    audited('configuration'),
    validator('param', CommandParamsSchema),
    async c => {
      const { id, commandId } = c.req.valid('param');
      await transaction(() => deleteChatCommand(id, commandId));
      return c.body(null, 204);
    }
  )
  .post(
    '/:commandId/triggers',
    describeRoute({
      operationId: 'organisations.chatCommands.trigger',
      ...operationVersion(1),
      summary: 'Say a chat command was used',
      description:
        "The agent of an output that goes out to the channel, signed as its device (an RFC 9421 HTTP Message Signature by its own identity, as for `reports.submit`): a viewer used the command in the channel's chat, with who they are there and the `words` that followed it. This API decides what comes of it, by `status`. `notRun`, with a `reason`, when the command is `disabled` or gone, the viewer is not in its `audience`, its words name no camera or preset it can use (`unresolved`), nothing can move the camera now (`unavailable`), or it is `resting` in its cooldown; such a use spends nothing of the cooldown. `ran` when it ran and finished here: a reply. `planned` when it ran and moves a camera: `cameraCommands` holds each command for the agent to carry out, the `agent` that reaches the camera, to dial over iroh at its `publicId` (itself, when it is that agent), the `command`, and a `grant` admitting exactly that command once, for this device alone, until `expiresAt`; nothing is said in chat until the agent settles the use with its `receipt` (`organisations.chatCommands.settle`), within a minute. `restsUntil` (ISO 8601) is when the command's rest ends, or null when it doesn't rest: the agent need not tell this API of a use before then. `reply` is what this API had to say, and `replied` whether it said so in the channel's chat itself, as the broadcaster: only Twitch connections made since chat commands can.",
      responses: {
        200: { description: 'What came of it' },
        400: invalidRequest,
        401: invalidSignature,
        403: notOutputAgent,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requireDevice,
    validator('param', CommandParamsSchema),
    validator('json', TriggerSchema),
    async c => {
      const { id, commandId } = c.req.valid('param');
      const trigger = c.req.valid('json');
      const device = useDevice();
      if (device.organisationId !== id) throw new ApiFailure('forbidden');
      const outcome = await trustedTransaction(() => useCommand(device, commandId, trigger), {
        name: 'chat_command.trigger'
      });
      // A planned use is answered in chat once it is settled. Twitch is called outside the transaction, which isn't
      // held open on the network.
      const reply = outcome.status === 'planned' ? null : outcome.reply;
      const replied = reply === null ? false : await say(id, trigger.channelId, reply, trigger.messageId);
      const answer = outcome.status === 'planned' ? outcome : { ...outcome, replied };
      c.header('Cache-Control', 'no-store');
      return c.json(answer, 200);
    }
  )
  .post(
    '/:commandId/settlements',
    describeRoute({
      operationId: 'organisations.chatCommands.settle',
      ...operationVersion(1),
      summary: 'Say what came of a planned chat command',
      description:
        "The agent a use of the command was `planned` for (`organisations.chatCommands.trigger`), signed as its device as for that: what came of carrying out its camera commands, with the use's `receipt`, within a minute of it. `carried`, and the camera took them; or the camera was `held` by someone at its controls, the agent that reaches it was `unreachable`, it `refused` the grant, or the camera `failed` to take the command. This API answers the use in the channel's chat: that the camera is moving, that someone is controlling it, or that it can't be moved right now. When it wasn't `carried`, the command's turn is given back, as it was before the use, unless another use has taken it since. `restsUntil` (ISO 8601) is when the command's rest ends after that, or null when it doesn't rest; `replied` is whether it was said in chat. `invalid_receipt` (400) for a receipt that is forged, lapsed, for another command, or another device's.",
      responses: {
        200: { description: 'Settled' },
        400: invalidReceipt,
        401: invalidSignature,
        403: notOutputAgent,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requireDevice,
    validator('param', CommandParamsSchema),
    validator('json', SettlementSchema),
    async c => {
      const { id, commandId } = c.req.valid('param');
      const settlement = c.req.valid('json');
      const device = useDevice();
      if (device.organisationId !== id) throw new ApiFailure('forbidden');
      const use = await verifyReceipt(settlement.receipt, device.id);
      if (use.commandId !== commandId) throw new ApiFailure('invalid_receipt');
      const settled = await trustedTransaction(() => settleUse(device, use, settlement.result), {
        name: 'chat_command.settle'
      });
      // Twitch is called outside the transaction, which isn't held open on the network.
      const replied = settled.reply === null ? false : await say(id, use.channelId, settled.reply, use.messageId);
      c.header('Cache-Control', 'no-store');
      return c.json({ restsUntil: settled.restsUntil, replied }, 200);
    }
  );
