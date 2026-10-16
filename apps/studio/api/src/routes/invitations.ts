import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { requirePrincipal, usePrincipal } from '../middleware/principal.ts';
import {
  acceptInvitation,
  declineInvitation,
  listOwnInvitations,
  readInvitation
} from '../organisations/invitations.ts';
import {
  alreadyMember,
  expired,
  invalidCode,
  invalidRequest,
  notFound,
  operationVersion,
  unauthenticated,
  unavailable,
  validator,
  versionMismatch
} from './openapi.ts';

const InvitationParamsSchema = z.object({ id: z.uuid().describe('The invitation.') });
export type InvitationParams = z.output<typeof InvitationParamsSchema>;

const InvitationCodeSchema = z
  .string()
  .min(1)
  .max(128)
  .describe("The one-time code from an emailed invitation's link.");
export type InvitationCode = z.output<typeof InvitationCodeSchema>;

// The invitee's side of invitations, all trusted code (src/organisations/invitations.ts): an emailed invitation
// belongs to no account until someone signs in and presents its code.
export default new Hono()
  .get(
    '/',
    describeRoute({
      operationId: 'invitations.listMine',
      ...operationVersion(1),
      summary: 'List your invitations',
      description:
        "Open invitations to the signed-in account. Invitations sent to an email address aren't listed: they're opened from their link.",
      responses: {
        200: { description: 'The invitations, oldest first' },
        401: unauthenticated,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    async c => {
      const principal = usePrincipal();
      const invitations = await listOwnInvitations(principal);
      c.header('Cache-Control', 'no-store');
      return c.json({ invitations }, 200);
    }
  )
  .get(
    '/:id',
    describeRoute({
      operationId: 'invitations.get',
      ...operationVersion(1),
      summary: 'Read an invitation',
      description:
        'An open invitation, for the page its link opens. Needs no sign-in: it shows the organisation, not who the invitation is for.',
      responses: {
        200: { description: 'The invitation' },
        400: invalidRequest,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    validator('param', InvitationParamsSchema),
    async c => {
      const invitation = await readInvitation(c.req.valid('param').id);
      c.header('Cache-Control', 'no-store');
      return c.json(invitation, 200);
    }
  )
  .post(
    '/:id/accept',
    describeRoute({
      operationId: 'invitations.accept',
      ...operationVersion(1),
      summary: 'Accept an invitation',
      description:
        'Joins the organisation as the signed-in account. An invitation to an account needs that account; an emailed one needs its code, whichever account presents it.',
      responses: {
        200: { description: 'The new membership' },
        400: invalidRequest,
        401: unauthenticated,
        403: invalidCode,
        404: notFound,
        409: alreadyMember,
        410: expired,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', InvitationParamsSchema),
    validator(
      'json',
      z.strictObject({
        code: InvitationCodeSchema.optional(),
        displayName: z.string().trim().min(1).max(120).describe("Your name as the organisation's members will see it.")
      })
    ),
    async c => {
      const body = c.req.valid('json');
      const principal = usePrincipal();
      const membership = await acceptInvitation(principal, c.req.valid('param').id, {
        code: body.code,
        displayName: body.displayName
      });
      c.header('Cache-Control', 'no-store');
      return c.json(membership, 200);
    }
  )
  .post(
    '/:id/decline',
    describeRoute({
      operationId: 'invitations.decline',
      ...operationVersion(1),
      summary: 'Decline an invitation',
      description: 'Deletes the invitation. Needs the same proof as accepting it.',
      responses: {
        204: { description: 'Declined' },
        400: invalidRequest,
        401: unauthenticated,
        403: invalidCode,
        404: notFound,
        410: expired,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', InvitationParamsSchema),
    validator('json', z.strictObject({ code: InvitationCodeSchema.optional() })),
    async c => {
      const principal = usePrincipal();
      await declineInvitation(principal, c.req.valid('param').id, { code: c.req.valid('json').code });
      return c.body(null, 204);
    }
  );
