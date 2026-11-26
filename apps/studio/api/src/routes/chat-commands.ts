import { CarryResultSchema, ChatAudienceSchema } from '@conservationtv/chat';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { audited } from '../audit/audit.ts';
import { ChatCommandActionSchema, ChatCommandNameSchema, type ReplyAction } from '../chat/commands.ts';
import { verifyReceipt } from '../chat/receipts.ts';
import { say, settleUse, useCommand } from '../chat/uses.ts';
import { transaction, trustedTransaction } from '../db/transaction.ts';
import { ApiFailure } from '../errors.ts';
import { requireDevice, useDevice } from '../middleware/device.ts';
import { requirePrincipal } from '../middleware/principal.ts';
import {
  createChatCommand,
  deleteChatCommand,
  getChatCommand,
  listChatCommands,
  updateChatCommand
} from '../services/chat-commands.ts';
import { pokeShow } from '../shows/pokes.ts';
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

export const CooldownSchema = z
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

const CommandChangesSchema = z
  .strictObject({
    name: ChatCommandNameSchema.optional(),
    action: ChatCommandActionSchema.optional(),
    audience: ChatAudienceSchema.optional(),
    cooldownSeconds: CooldownSchema.optional(),
    enabled: z.boolean().optional()
  })
  .refine(changes => Object.keys(changes).length > 0, 'Provide at least one field to change');
export type CommandChanges = z.output<typeof CommandChangesSchema>;

/** One use of a command, as the agent that heard it tells it. */
export const TriggerSchema = z.strictObject({
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
export const SettlementSchema = z.strictObject({
  receipt: z.string().min(1).max(4096).describe('The `receipt` the use was planned with.'),
  result: CarryResultSchema
});
export type Settlement = z.output<typeof SettlementSchema>;

/**
 * What a command did as the version 1 reads tell of it: a reply, or pointing a camera at a preset, which no command
 * does any more (the standard commands do it), so they tell only of replies.
 */
type FirstAction = ReplyAction | FirstCameraPresetAction;

/** Pointing a camera at one of its presets, as the version 1 reads describe it. */
interface FirstCameraPresetAction {
  kind: 'cameraPreset';
  cameraId: string | null;
  preset: string | null;
}

/** A command, with what it does now. */
interface Acting {
  action: ReplyAction;
}

/** A command, with what it does as the version 1 reads describe it. */
interface FirstActing {
  action: FirstAction;
}

/** A command as the version 1 reads return it. */
function asFirst<Command extends Acting>(command: Command): Omit<Command, 'action'> & FirstActing {
  return command;
}

// An organisation's own chat commands: members read them, administrators manage them. Each replies; the cameras, the
// layout and the mix are the standard commands' (src/routes/standard-chat-commands.ts). Uses of either are told to
// this API by the agent that heard them (src/routes/chat-uses.ts); `trigger` and `settle` here are how agents built
// before the standard commands tell of an own command's, by its ID, and are decided the same way (src/chat/uses.ts).
// Version 1 of `create` and `update`, which took camera commands, is retired.
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
      const commands = rows.map(asFirst);
      c.header('Cache-Control', 'no-store');
      return c.json({ commands }, 200);
    }
  )
  .get(
    '/',
    describeRoute({
      operationId: 'organisations.chatCommands.list',
      ...operationVersion(2),
      summary: "List an organisation's own chat commands",
      description:
        'Each replies (`action.kind: reply`); the standard commands are `organisations.chatCommands.standard.list`. Empty for organisations you are not a member of.',
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
      ...operationVersion(2),
      summary: 'Add a chat command',
      description:
        "Administrators only. A command of the organisation's own is the word viewers type after `!` in the chat of the channels its outputs listen to, who may use it (`audience`, moderators unless said), how long it rests after it runs (`cooldownSeconds`, 5 unless said), and what it says (`action`: a `reply`). Its word may not be one a standard command is used by (400). The agents of outputs that listen to Twitch channels listen for it from their next configuration. `conflict` (409) when the organisation has a command used by that word.",
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
      return c.json(asFirst(row), 200);
    }
  )
  .get(
    '/:commandId',
    describeRoute({
      operationId: 'organisations.chatCommands.get',
      ...operationVersion(2),
      summary: 'Read a chat command',
      description: "One of the organisation's own: it replies.",
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
      ...operationVersion(2),
      summary: 'Update a chat command',
      description:
        'Administrators only. Changes the fields given; its `action` is replaced whole. Its word may not become one a standard command is used by (400).',
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
    validator('json', CommandChangesSchema),
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
        "For agents built before the standard commands, which tell of an own command's use by its ID; later agents tell of any command's by its word (`organisations.chatCommands.uses.create`), and it is decided the same way. The agent of an output whose chat the channel's is (one it goes out to, or one of its control channels), signed as its device (an RFC 9421 HTTP Message Signature by its own identity, as for `reports.submit`): a viewer used the command in the channel's chat, with who they are there and the `words` that followed it. This API decides what comes of it, by `status`. `notRun`, with a `reason`, when the command is `disabled` or gone, the viewer is not in its `audience`, its words name no camera or preset it can use (`unresolved`), nothing can move the camera now (`unavailable`), or it is `resting` in its cooldown; such a use spends nothing of the cooldown. `ran` when it ran and finished here: a reply. `planned` when it ran and moves a camera: `cameraCommands` holds each command for the agent to carry out, the `agent` that reaches the camera, to dial over iroh at its `publicId` (itself, when it is that agent), the `command`, and a `grant` admitting exactly that command once, for this device alone, until `expiresAt`; nothing is said in chat until the agent settles the use with its `receipt` (`organisations.chatCommands.settle`), within a minute. `restsUntil` (ISO 8601) is when the command's rest ends, or null when it doesn't rest: the agent need not tell this API of a use before then. `reply` is what this API had to say, and `replied` whether it said so in the channel's chat itself, as the broadcaster: only Twitch connections made since chat commands can.",
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
      const { outcome, changedShowId } = await trustedTransaction(() => useCommand(device, { commandId }, trigger), {
        name: 'chat_command.trigger'
      });
      // A show it changed looks again once that has committed.
      if (changedShowId !== undefined) pokeShow(changedShowId);
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
        "The agent a use of the command was `planned` for (`organisations.chatCommands.trigger`), signed as its device as for that: what came of carrying out its camera commands, with the use's `receipt`, within a minute of it. `carried`, and the camera took them; or the camera was `held` by someone at its controls, the agent that reaches it was `unreachable`, it `refused` the grant, or the camera `failed` to take the command. This API answers the use in the channel's chat: that the camera is moving, or, only to a moderator or the broadcaster, that someone is controlling it or that it can't be moved right now. When it wasn't `carried`, the command's turn is given back, as it was before the use, unless another use has taken it since. `restsUntil` (ISO 8601) is when the command's rest ends after that, or null when it doesn't rest; `replied` is whether it was said in chat. `invalid_receipt` (400) for a receipt that is forged, lapsed, for another command, or another device's.",
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
      if (use.turn.kind !== 'own' || use.turn.commandId !== commandId) throw new ApiFailure('invalid_receipt');
      const settled = await trustedTransaction(() => settleUse(device, use, settlement.result), {
        name: 'chat_command.settle'
      });
      // Twitch is called outside the transaction, which isn't held open on the network.
      const replied = settled.reply === null ? false : await say(id, use.channelId, settled.reply, use.messageId);
      c.header('Cache-Control', 'no-store');
      return c.json({ restsUntil: settled.restsUntil, replied }, 200);
    }
  );
