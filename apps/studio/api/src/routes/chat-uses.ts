import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { verifyReceipt } from '../chat/receipts.ts';
import { say, settleUse, useCommand } from '../chat/uses.ts';
import { trustedTransaction } from '../db/transaction.ts';
import { ApiFailure } from '../errors.ts';
import { requireDevice, useDevice } from '../middleware/device.ts';
import { pokeShow } from '../shows/pokes.ts';
import { SettlementSchema, TriggerSchema } from './chat-commands.ts';
import {
  invalidReceipt,
  invalidRequest,
  invalidSignature,
  notOutputAgent,
  operationVersion,
  unavailable,
  validator,
  versionMismatch
} from './openapi.ts';

const OrganisationParamsSchema = z.object({ id: z.uuid().describe('The organisation.') });
export type OrganisationParams = z.output<typeof OrganisationParamsSchema>;

/** One use of a command, by the word it was used by. */
const UseSchema = TriggerSchema.extend({
  command: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/u)
    .describe(
      "The word the command was used by, after its `!`, lowercased: a standard command's name or alias, or one of the organisation's own."
    )
});
export type Use = z.output<typeof UseSchema>;

// Uses of chat commands, as the agent of an output tells them: any command, standard or the organisation's own, by
// the word it was used by (`create`), and what came of carrying out the camera commands one was planned to (`settle`).
// The agent only listens and carries: whether a command runs, what it does, and what is said in chat, is decided here
// each time, in the order src/chat/decide.ts sets out (src/chat/uses.ts). A layout or audio command runs here, on the
// show the agent's output follows, and answers `ran`, so the agent carries nothing for it.
export default new Hono()
  .post(
    '/',
    describeRoute({
      operationId: 'organisations.chatCommands.uses.create',
      ...operationVersion(1),
      summary: 'Say a chat command was used',
      description:
        "The agent of an output whose chat the channel's is (one it goes out to, or one of its control channels), signed as its device (an RFC 9421 HTTP Message Signature by its own identity, as for `reports.submit`): a viewer used the `command` in the channel's chat, with who they are there and the `words` that followed it. The command is a standard one, by its name or an alias (`organisations.chatCommands.standard.list`), or one of the organisation's own. This API decides what comes of it, by `status`. `notRun`, with a `reason`, when the command is `disabled`, switched off or not there, the viewer is not in its `audience`, its words name no camera, preset or stream it can use (`unresolved`), nothing can act on it now (`unavailable`: no agent reaches the camera, or the output follows no show), or it is `resting` in its cooldown; such a use spends nothing of the cooldown. `ran` when it ran and finished here: a reply, or a change to the show the output follows, which everyone following it sees. `planned` when it ran and moves a camera: `cameraCommands` holds each command for the agent to carry out, in order, the `agent` that reaches the camera, to dial over iroh at its `publicId` (itself, when it is that agent), the `command`, and a `grant` admitting exactly that command once, for this device alone, until `expiresAt`; nothing is said in chat until the agent settles the use with its `receipt` (`organisations.chatCommands.uses.settle`), within a minute. `restsUntil` (ISO 8601) is when the command's rest ends, or null when it doesn't rest: an own command rests as a whole, a standard camera command on its camera, and a layout or audio command on its show. `reply` is what this API had to say, and `replied` whether it said so in the channel's chat itself, as the broadcaster: only Twitch connections that may chat can.",
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
    validator('param', OrganisationParamsSchema),
    validator('json', UseSchema),
    async c => {
      const { id } = c.req.valid('param');
      const { command, ...trigger } = c.req.valid('json');
      const device = useDevice();
      if (device.organisationId !== id) throw new ApiFailure('forbidden');
      const { outcome, changedShowId } = await trustedTransaction(
        () => useCommand(device, { word: command }, trigger),
        { name: 'chat_command.use' }
      );
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
    '/settlements',
    describeRoute({
      operationId: 'organisations.chatCommands.uses.settle',
      ...operationVersion(1),
      summary: 'Say what came of a planned chat command',
      description:
        "The agent a use was `planned` for (`organisations.chatCommands.uses.create`), signed as its device as for that: what came of carrying out its camera commands, with the use's `receipt`, within a minute of it. `carried`, and the camera took them; or the camera was `held` by someone at its controls, the agent that reaches it was `unreachable`, it `refused` the grant, or the camera `failed` to take the command. This API answers the use in the channel's chat: that the camera is moving, or, only to a moderator or the broadcaster, that someone is controlling it or that it can't be moved right now. When it wasn't `carried`, the turn the use took is given back, as it was before the use, unless another use has taken it since. `restsUntil` (ISO 8601) is when the command's rest ends there after that, or null when it doesn't rest; `replied` is whether it was said in chat. `invalid_receipt` (400) for a receipt that is forged, lapsed, or another device's.",
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
    validator('param', OrganisationParamsSchema),
    validator('json', SettlementSchema),
    async c => {
      const { id } = c.req.valid('param');
      const settlement = c.req.valid('json');
      const device = useDevice();
      if (device.organisationId !== id) throw new ApiFailure('forbidden');
      const use = await verifyReceipt(settlement.receipt, device.id);
      const settled = await trustedTransaction(() => settleUse(device, use, settlement.result), {
        name: 'chat_command.settle'
      });
      // Twitch is called outside the transaction, which isn't held open on the network.
      const replied = settled.reply === null ? false : await say(id, use.channelId, settled.reply, use.messageId);
      c.header('Cache-Control', 'no-store');
      return c.json({ restsUntil: settled.restsUntil, replied }, 200);
    }
  );
