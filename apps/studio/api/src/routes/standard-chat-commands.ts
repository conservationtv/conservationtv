import { ChatAudienceSchema, StandardCommandNameSchema } from '@conservationtv/chat';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { audited } from '../audit/audit.ts';
import { transaction } from '../db/transaction.ts';
import { requirePrincipal, usePrincipal } from '../middleware/principal.ts';
import { listStandardCommands, resetStandardCommand, setStandardCommand } from '../services/chat-commands.ts';
import { CooldownSchema } from './chat-commands.ts';
import {
  forbidden,
  invalidRequest,
  notFound,
  operationVersion,
  unauthenticated,
  unavailable,
  validator,
  versionMismatch
} from './openapi.ts';

const OrganisationParamsSchema = z.object({ id: z.uuid().describe('The organisation.') });
export type OrganisationParams = z.output<typeof OrganisationParamsSchema>;
const StandardParamsSchema = OrganisationParamsSchema.extend({ name: StandardCommandNameSchema });
export type StandardParams = z.output<typeof StandardParamsSchema>;

const StandardChangesSchema = z
  .strictObject({
    enabled: z.boolean().optional().describe('Whether chat can use it.'),
    audience: ChatAudienceSchema.optional(),
    cooldownSeconds: CooldownSchema.optional().describe(
      'How many seconds it rests after it runs on a camera (a camera command) or the show (a layout or audio command).'
    )
  })
  .refine(changes => Object.keys(changes).length > 0, 'Provide at least one field to change');
export type StandardChanges = z.output<typeof StandardChangesSchema>;

const LISTED =
  'Each with its `name` and the `aliases` it is also used by, its `group` (`camera`, `layout` or `audio`), the `target` it rests per (a `camera`, or the `show` the output follows), its `usage` and `description`, and as the organisation has it: whether it is `enabled`, its `audience` and its `cooldownSeconds`, and when the organisation last changed it (`changedAt`, null while it is as it comes).';

// The standard chat commands (`@conservationtv/chat`), which every organisation has for every camera, with nothing to
// register: members read how the organisation has them, administrators change them, or put them back as they come.
export default new Hono()
  .get(
    '/',
    describeRoute({
      operationId: 'organisations.chatCommands.standard.list',
      ...operationVersion(1),
      summary: 'List the standard chat commands',
      description: `The camera, layout and audio commands every organisation has, following Alveus Sanctuary's. ${LISTED} As they come for organisations you are not a member of.`,
      responses: {
        200: { description: 'The commands, camera commands first' },
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
      const commands = await transaction(() => listStandardCommands(id));
      c.header('Cache-Control', 'no-store');
      return c.json({ commands }, 200);
    }
  )
  .patch(
    '/:name',
    describeRoute({
      operationId: 'organisations.chatCommands.standard.update',
      ...operationVersion(1),
      summary: 'Change a standard chat command',
      description: `Administrators only: switch it on or off, or change who may use it or how long it rests, for the organisation. Only the fields given change. The agents of its outputs listen for it as it is from their next configuration. ${LISTED}`,
      responses: {
        200: { description: 'The command, as the organisation has it now' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    audited('configuration'),
    validator('param', StandardParamsSchema),
    validator('json', StandardChangesSchema),
    async c => {
      const { id, name } = c.req.valid('param');
      const changes = c.req.valid('json');
      const command = await transaction(() => setStandardCommand(id, name, changes));
      c.header('Cache-Control', 'no-store');
      return c.json(command, 200);
    }
  )
  .delete(
    '/:name',
    describeRoute({
      operationId: 'organisations.chatCommands.standard.reset',
      ...operationVersion(1),
      summary: 'Put a standard chat command back as it comes',
      description: `Administrators only: on, for the audience and with the cooldown it comes with. ${LISTED}`,
      responses: {
        200: { description: 'The command, as it comes' },
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
    validator('param', StandardParamsSchema),
    async c => {
      const { id, name } = c.req.valid('param');
      const principal = usePrincipal();
      const command = await transaction(() => resetStandardCommand(principal, id, name));
      c.header('Cache-Control', 'no-store');
      return c.json(command, 200);
    }
  );
