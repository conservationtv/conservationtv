import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { describeRoute } from 'hono-openapi';
import { z } from 'zod';
import type { Session } from '@conservationtv/umbrella';
import { organisationProfiles, organisations } from '../db/schema.ts';
import { ApiFailure } from '../errors.ts';
import { requirePrincipal, usePrincipal } from '../middleware/principal.ts';
import { cancelInvitation, createInvitation, listOrganisationInvitations } from '../organisations/invitations.ts';
import {
  createOrganisation,
  deleteOrganisation,
  endMembership,
  grantAdmin,
  listMembers,
  listOwnOrganisations,
  revokeAdmin
} from '../organisations/membership.ts';
import { useServices } from '../services.ts';
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

/** Whether the organisation is visible to the session: distinguishes "not yours" from "not allowed". */
async function visible(session: Session, organisationId: string) {
  const rows = await session.transaction(tx =>
    tx.select({ id: organisations.id }).from(organisations).where(eq(organisations.id, organisationId))
  );
  return rows.length > 0;
}

// Reads and edits run in the principal's request session, so row-level security decides what each account sees.
// Creating, joining, removing and deleting change grants as well as rows: src/organisations/membership.ts.
// Invitations: src/organisations/invitations.ts.
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
      const rows = await listOwnOrganisations(usePrincipal());
      c.header('Cache-Control', 'no-store');
      return c.json(
        {
          organisations: rows.map(row => ({
            id: row.id,
            name: row.name,
            created_at: row.createdAt.toISOString(),
            roles: row.roles
          }))
        },
        200
      );
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
        display_name: z.string().trim().min(1).max(120).describe("Your name as the organisation's members will see it.")
      })
    ),
    async c => {
      const body = c.req.valid('json');
      const organisation = await createOrganisation(usePrincipal(), {
        name: body.name,
        displayName: body.display_name
      });
      c.header('Cache-Control', 'no-store');
      return c.json(
        { id: organisation.id, name: organisation.name, created_at: organisation.createdAt.toISOString() },
        201
      );
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
      const session = await useServices().session(usePrincipal());
      const [row] = await session.transaction(tx =>
        tx
          .select({ id: organisations.id, name: organisations.name, createdAt: organisations.createdAt })
          .from(organisations)
          .where(eq(organisations.id, id))
      );
      if (!row) throw new ApiFailure('not_found');
      c.header('Cache-Control', 'no-store');
      return c.json({ id: row.id, name: row.name, created_at: row.createdAt.toISOString() }, 200);
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
      const session = await useServices().session(usePrincipal());
      const [row] = await session.transaction(tx =>
        tx
          .update(organisations)
          .set(c.req.valid('json'))
          .where(eq(organisations.id, id))
          .returning({ id: organisations.id, name: organisations.name, createdAt: organisations.createdAt })
      );
      if (!row) throw new ApiFailure((await visible(session, id)) ? 'forbidden' : 'not_found');
      c.header('Cache-Control', 'no-store');
      return c.json({ id: row.id, name: row.name, created_at: row.createdAt.toISOString() }, 200);
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
      await deleteOrganisation(usePrincipal(), c.req.valid('param').id);
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
      const session = await useServices().session(usePrincipal());
      if (!(await visible(session, id))) throw new ApiFailure('not_found');
      const rows = await listMembers(id);
      c.header('Cache-Control', 'no-store');
      return c.json(
        {
          members: rows.map(row => ({
            user_id: row.userId,
            display_name: row.displayName,
            joined_at: row.joinedAt.toISOString(),
            roles: row.roles
          }))
        },
        200
      );
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
      z.strictObject({ display_name: z.string().trim().min(1).max(120).describe('Your name in this organisation.') })
    ),
    async c => {
      const principal = usePrincipal();
      const { id } = c.req.valid('param');
      const session = await useServices().session(principal);
      const [row] = await session.transaction(tx =>
        tx
          .update(organisationProfiles)
          .set({ displayName: c.req.valid('json').display_name })
          .where(and(eq(organisationProfiles.organisationId, id), eq(organisationProfiles.userId, principal.id)))
          .returning({ userId: organisationProfiles.userId, displayName: organisationProfiles.displayName })
      );
      if (!row) throw new ApiFailure('not_found');
      c.header('Cache-Control', 'no-store');
      return c.json({ user_id: row.userId, display_name: row.displayName }, 200);
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
      const principal = usePrincipal();
      const { id, userId } = c.req.valid('param');
      await endMembership(principal, id, userId === 'me' ? principal.id : userId);
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
      const principal = usePrincipal();
      const { id, userId } = c.req.valid('param');
      await grantAdmin(principal, id, userId === 'me' ? principal.id : userId);
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
      const principal = usePrincipal();
      const { id, userId } = c.req.valid('param');
      await revokeAdmin(principal, id, userId === 'me' ? principal.id : userId);
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
      const invitations = await listOrganisationInvitations(usePrincipal(), c.req.valid('param').id);
      c.header('Cache-Control', 'no-store');
      return c.json(
        {
          invitations: invitations.map(invitation => ({
            id: invitation.id,
            email: invitation.email,
            user_id: invitation.userId,
            invited_by: invitation.invitedBy,
            created_at: invitation.createdAt.toISOString(),
            expires_at: invitation.expiresAt.toISOString()
          }))
        },
        200
      );
    }
  )
  .post(
    '/:id/invitations',
    describeRoute({
      operationId: 'organisations.invitations.create',
      ...operationVersion(1),
      summary: 'Invite someone',
      description:
        'Administrators only. Give exactly one of `email`, which is sent a link with a one-time code that whoever holds it can accept, or `user_id`, an account that accepts by signing in. Invitations last 14 days.',
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
          user_id: z.string().min(1).max(64).optional().describe('The account to invite.')
        })
        .transform(({ email, user_id }, context) => {
          // One flat object keeps the CLI's flags simple; exactly one recipient becomes the invitation's.
          if (email !== undefined && user_id === undefined) return { email };
          if (user_id !== undefined && email === undefined) return { userId: user_id };
          context.addIssue({ code: 'custom', message: 'Provide exactly one of email or user_id' });
          return z.NEVER;
        })
    ),
    async c => {
      const invitation = await createInvitation(usePrincipal(), c.req.valid('param').id, c.req.valid('json'));
      c.header('Cache-Control', 'no-store');
      return c.json(
        {
          id: invitation.id,
          email: invitation.email,
          user_id: invitation.userId,
          invited_by: invitation.invitedBy,
          created_at: invitation.createdAt.toISOString(),
          expires_at: invitation.expiresAt.toISOString()
        },
        201
      );
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
      await cancelInvitation(usePrincipal(), id, invitationId);
      return c.body(null, 204);
    }
  );
