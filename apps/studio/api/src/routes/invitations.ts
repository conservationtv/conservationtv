import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { trustedTransaction } from '../db/transaction.ts';
import { ApiFailure } from '../errors.ts';
import { requirePrincipal, useUser } from '../middleware/principal.ts';
import {
  deleteInvitation,
  getOpenInvitation,
  listOwnInvitations,
  lockRedeemableInvitation
} from '../services/invitations.ts';
import { addMember } from '../services/organisations.ts';
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

// The invitee's side of invitations, all trusted code (src/services/invitations.ts): an emailed invitation belongs to
// no account until someone signs in and presents its code.
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
      const principal = useUser();
      const invitations = await trustedTransaction(() => listOwnInvitations(principal.id));
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
      const { id } = c.req.valid('param');
      const invitation = await trustedTransaction(() => getOpenInvitation(id));
      if (!invitation) throw new ApiFailure('not_found');
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
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      const principal = useUser();
      // Joins as the user, using the invitation up.
      const membership = await trustedTransaction(async () => {
        const invitation = await lockRedeemableInvitation(id, principal.id, { code: body.code });
        const joined = await addMember(invitation.organisationId, principal.id, { displayName: body.displayName });
        await deleteInvitation(invitation.organisationId, invitation.id);
        return joined;
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
      const { id } = c.req.valid('param');
      const proof = c.req.valid('json');
      const principal = useUser();
      await trustedTransaction(async () => {
        const invitation = await lockRedeemableInvitation(id, principal.id, proof);
        await deleteInvitation(invitation.organisationId, invitation.id);
      });
      return c.body(null, 204);
    }
  );
