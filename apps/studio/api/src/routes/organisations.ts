import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import { transaction, trustedTransaction } from '../db/transaction.ts';
import { ApiFailure } from '../errors.ts';
import { requirePrincipal, useUser } from '../middleware/principal.ts';
import { deleteMemberBrowsers } from '../services/browsers.ts';
import {
  createInvitation,
  deleteExpiredInvitations,
  deleteInvitation,
  invitationCode,
  listOrganisationInvitations,
  type Recipient,
  sendInvitation
} from '../services/invitations.ts';
import {
  addMember,
  createOrganisation,
  deleteOrganisation,
  endMembership,
  getMembership,
  getOrganisation,
  grantAdmin,
  keepAnotherAdmin,
  listMembers,
  listOwnOrganisations,
  lockOrganisation,
  requireAdmin,
  requireMemberRemoval,
  requireOrganisationRemoval,
  revokeAdmin,
  updateOrganisation,
  updateProfile
} from '../services/organisations.ts';
import {
  accountNotFound,
  alreadyInvited,
  forbidden,
  lastAdmin,
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
const MemberParamsSchema = OrganisationParamsSchema.extend({
  userId: z.string().min(1).max(64).describe("The member's account ID, or `me`.")
});
export type MemberParams = z.output<typeof MemberParamsSchema>;

// Reads and edits run in the principal's request session, so row-level security decides what each account sees.
// Creating, joining, removing and deleting change grants as well as rows, so they are trusted transactions, which
// check the principal's permissions first (src/services/organisations.ts). Invitations: src/services/invitations.ts.
export default new Hono()
  .get(
    '/',
    describeRoute({
      operationId: 'organisations.list',
      ...operationVersion(1),
      summary: 'List your organisations',
      description:
        'The organisations the signed-in account is a member of, with the roles it holds in each. Invitations are under `/invitations`.',
      responses: {
        200: { description: 'The organisations, oldest first' },
        401: unauthenticated,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    async c => {
      const principal = useUser();
      const rows = await transaction(() => listOwnOrganisations(principal.id));
      c.header('Cache-Control', 'no-store');
      return c.json({ organisations: rows }, 200);
    }
  )
  .post(
    '/',
    describeRoute({
      operationId: 'organisations.create',
      ...operationVersion(1),
      summary: 'Create an organisation',
      description: 'Creates an organisation with the signed-in account as its first member and administrator.',
      responses: {
        201: { description: 'The new organisation' },
        400: invalidRequest,
        401: unauthenticated,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator(
      'json',
      z.strictObject({
        name: z.string().trim().min(1).max(120).describe('The organisation name.'),
        displayName: z.string().trim().min(1).max(120).describe("Your name as the organisation's members will see it.")
      })
    ),
    async c => {
      const body = c.req.valid('json');
      const principal = useUser();
      // The creator is its first member and administrator.
      const organisation = await trustedTransaction(async () => {
        const created = await createOrganisation({ name: body.name });
        await addMember(created.id, principal.id, { displayName: body.displayName });
        await grantAdmin(created.id, principal.id);
        return created;
      });
      c.header('Cache-Control', 'no-store');
      return c.json(organisation, 201);
    }
  )
  .get(
    '/:id',
    describeRoute({
      operationId: 'organisations.get',
      ...operationVersion(1),
      summary: 'Read an organisation',
      description: 'An organisation the signed-in account is a member of.',
      responses: {
        200: { description: 'The organisation' },
        400: invalidRequest,
        401: unauthenticated,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', OrganisationParamsSchema),
    async c => {
      const { id } = c.req.valid('param');
      const row = await transaction(() => getOrganisation(id));
      if (!row) throw new ApiFailure('not_found');
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .patch(
    '/:id',
    describeRoute({
      operationId: 'organisations.update',
      ...operationVersion(1),
      summary: 'Rename an organisation',
      description: 'Administrators only.',
      responses: {
        200: { description: 'The updated organisation' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', OrganisationParamsSchema),
    validator('json', z.strictObject({ name: z.string().trim().min(1).max(120).describe('The organisation name.') })),
    async c => {
      const { id } = c.req.valid('param');
      const changes = c.req.valid('json');
      const row = await transaction(() => updateOrganisation(id, changes));
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .delete(
    '/:id',
    describeRoute({
      operationId: 'organisations.delete',
      ...operationVersion(1),
      summary: 'Delete an organisation',
      description: "Global administrators only. Deletes its memberships, profiles and everyone's access to it.",
      responses: {
        204: { description: 'Deleted' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', OrganisationParamsSchema),
    async c => {
      const { id } = c.req.valid('param');
      const principal = useUser();
      await trustedTransaction(async () => {
        await lockOrganisation(id, principal.id);
        await requireOrganisationRemoval(id, principal.id);
        await deleteOrganisation(id);
      });
      return c.body(null, 204);
    }
  )
  .get(
    '/:id/members',
    describeRoute({
      operationId: 'organisations.members.list',
      ...operationVersion(1),
      summary: "List an organisation's members",
      description:
        'The member directory: each member, with their profile and the roles they hold in this organisation.',
      responses: {
        200: { description: 'The members, longest-standing first' },
        400: invalidRequest,
        401: unauthenticated,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', OrganisationParamsSchema),
    async c => {
      const { id } = c.req.valid('param');
      const rows = await transaction(async () => {
        const members = await listMembers(id);
        // Every member sees at least themselves, so no rows means the organisation is hidden, or its members are.
        if (members.length === 0 && !(await getOrganisation(id))) throw new ApiFailure('not_found');
        return members;
      });
      c.header('Cache-Control', 'no-store');
      return c.json({ members: rows }, 200);
    }
  )
  .patch(
    '/:id/members/me',
    describeRoute({
      operationId: 'organisations.members.updateSelf',
      ...operationVersion(1),
      summary: 'Update your profile in an organisation',
      description: "Changes how the organisation's members see the signed-in account.",
      responses: {
        200: { description: 'Your updated profile' },
        400: invalidRequest,
        401: unauthenticated,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', OrganisationParamsSchema),
    validator(
      'json',
      z.strictObject({ displayName: z.string().trim().min(1).max(120).describe('Your name in this organisation.') })
    ),
    async c => {
      const principal = useUser();
      const { id } = c.req.valid('param');
      const changes = c.req.valid('json');
      const row = await transaction(() => updateProfile(id, principal.id, changes));
      if (!row) throw new ApiFailure('not_found');
      c.header('Cache-Control', 'no-store');
      return c.json(row, 200);
    }
  )
  .delete(
    '/:id/members/:userId',
    describeRoute({
      operationId: 'organisations.members.remove',
      ...operationVersion(1),
      summary: 'Remove a member',
      description:
        'Ends a membership, with its profile and access: administrators remove anyone, and anyone may remove themselves (`me`). The last administrator cannot be removed.',
      responses: {
        204: { description: 'Removed' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        409: lastAdmin,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', MemberParamsSchema),
    async c => {
      const principal = useUser();
      const { id, userId } = c.req.valid('param');
      const memberId = userId === 'me' ? principal.id : userId;
      // Anyone may end their own membership; ending someone else's needs the remove permission. Either way the
      // organisation must keep an administrator other than the member leaving, counting only active grants.
      await trustedTransaction(async () => {
        await lockOrganisation(id, principal.id);
        const membership = await getMembership(id, memberId);
        if (!membership) throw new ApiFailure('not_found');
        if (membership.userId !== principal.id) await requireMemberRemoval(id, principal.id);
        await keepAnotherAdmin(id, membership.userId);
        await deleteMemberBrowsers(id, membership.userId);
        await endMembership(id, membership.userId);
      });
      return c.body(null, 204);
    }
  )
  .put(
    '/:id/members/:userId/admin',
    describeRoute({
      operationId: 'organisations.members.grantAdmin',
      ...operationVersion(1),
      summary: 'Make a member an administrator',
      description: 'Administrators only. Granting it to someone who already holds it changes nothing.',
      responses: {
        204: { description: 'The member is an administrator' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', MemberParamsSchema),
    async c => {
      const principal = useUser();
      const { id, userId } = c.req.valid('param');
      const memberId = userId === 'me' ? principal.id : userId;
      await trustedTransaction(async () => {
        await lockOrganisation(id, principal.id);
        await requireAdmin(id, principal.id);
        const membership = await getMembership(id, memberId);
        if (!membership) throw new ApiFailure('not_found');
        await grantAdmin(id, membership.userId);
      });
      return c.body(null, 204);
    }
  )
  .delete(
    '/:id/members/:userId/admin',
    describeRoute({
      operationId: 'organisations.members.revokeAdmin',
      ...operationVersion(1),
      summary: "Remove a member's administrator role",
      description:
        'Administrators only, themselves included. The member stays a member. The last administrator cannot lose it.',
      responses: {
        204: { description: 'The member is not an administrator' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: notFound,
        409: lastAdmin,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', MemberParamsSchema),
    async c => {
      const principal = useUser();
      const { id, userId } = c.req.valid('param');
      const memberId = userId === 'me' ? principal.id : userId;
      await trustedTransaction(async () => {
        await lockOrganisation(id, principal.id);
        await requireAdmin(id, principal.id);
        const membership = await getMembership(id, memberId);
        if (!membership) throw new ApiFailure('not_found');
        await keepAnotherAdmin(id, membership.userId);
        await revokeAdmin(id, membership.userId);
      });
      return c.body(null, 204);
    }
  )
  .get(
    '/:id/invitations',
    describeRoute({
      operationId: 'organisations.invitations.list',
      ...operationVersion(1),
      summary: "List an organisation's invitations",
      description: 'Administrators only; anyone else sees none. Includes expired invitations until they are cancelled.',
      responses: {
        200: { description: 'The invitations, oldest first' },
        400: invalidRequest,
        401: unauthenticated,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', OrganisationParamsSchema),
    async c => {
      const { id } = c.req.valid('param');
      const invitations = await transaction(async () => {
        const organisation = await getOrganisation(id);
        if (!organisation) throw new ApiFailure('not_found');
        return listOrganisationInvitations(id);
      });
      c.header('Cache-Control', 'no-store');
      return c.json({ invitations }, 200);
    }
  )
  .post(
    '/:id/invitations',
    describeRoute({
      operationId: 'organisations.invitations.create',
      ...operationVersion(1),
      summary: 'Invite someone',
      description:
        'Administrators only. Give exactly one of `email`, which is sent a link with a one-time code that whoever holds it can accept, or `userId`, an account that accepts by signing in. Invitations last 14 days.',
      responses: {
        201: { description: 'The invitation' },
        400: invalidRequest,
        401: unauthenticated,
        403: forbidden,
        404: accountNotFound,
        409: alreadyInvited,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', OrganisationParamsSchema),
    validator(
      'json',
      z
        .strictObject({
          email: z.email().max(320).optional().describe('The address to send the invitation to.'),
          userId: z.string().min(1).max(64).optional().describe('The account to invite.')
        })
        .transform(({ email, userId }, context) => {
          // One flat object keeps the CLI's flags simple; exactly one recipient becomes the invitation's.
          if (email !== undefined && userId === undefined) return { email };
          if (userId !== undefined && email === undefined) return { userId };
          context.addIssue({ code: 'custom', message: 'Provide exactly one of email or userId' });
          return z.NEVER;
        })
    ),
    async c => {
      const { id } = c.req.valid('param');
      const recipient: Recipient = c.req.valid('json');
      const principal = useUser();
      // An emailed invitation is sent a link with a one-time code; one to an account is found by it under
      // `/invitations`. An expired invitation to the same recipient is replaced.
      const code = 'email' in recipient ? invitationCode() : null;
      const { invitation, organisation } = await transaction(async () => {
        const visible = await getOrganisation(id);
        if (!visible) throw new ApiFailure('not_found');
        const member = 'userId' in recipient ? await getMembership(id, recipient.userId) : undefined;
        if (member) throw new ApiFailure('already_member');
        await deleteExpiredInvitations(id, recipient);
        const created = await createInvitation(id, { recipient, invitedBy: principal.id, code });
        return { invitation: created, organisation: visible };
      });
      if (code !== null && invitation.email !== null) {
        await sendInvitation(invitation.id, { email: invitation.email, organisationName: organisation.name, code });
      }
      c.header('Cache-Control', 'no-store');
      return c.json(invitation, 201);
    }
  )
  .delete(
    '/:id/invitations/:invitationId',
    describeRoute({
      operationId: 'organisations.invitations.cancel',
      ...operationVersion(1),
      summary: 'Cancel an invitation',
      description: 'Administrators only.',
      responses: {
        204: { description: 'Cancelled' },
        400: invalidRequest,
        401: unauthenticated,
        404: notFound,
        412: versionMismatch,
        503: unavailable
      }
    }),
    requirePrincipal,
    validator('param', OrganisationParamsSchema.extend({ invitationId: z.uuid().describe('The invitation.') })),
    async c => {
      const { id, invitationId } = c.req.valid('param');
      await transaction(() => deleteInvitation(id, invitationId));
      return c.body(null, 204);
    }
  );
