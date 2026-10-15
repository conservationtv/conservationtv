import { withAccess } from '@conservationtv/umbrella';
import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { organisationAdmin } from '../roles.ts';
import { organisations } from './organisations.ts';
import { users } from './users.ts';

/**
 * An open invitation to join an organisation: either to a known account (`userId`), or to an email address, which
 * receives a link with a one-time code. Only the code's hash is stored. Whoever signs in and presents the code may
 * accept, so an emailed invitation can be passed on to a different address.
 *
 * Administrators create, list and cancel their organisation's invitations through their request session: none of
 * that changes grants. The invitee's side (reading an invitation by its link, listing their own, accepting, declining)
 * is trusted code in src/organisations/invitations.ts, because an emailed invitation belongs to no account until it is
 * accepted. The application role cannot read `code_hash`.
 */
export const organisationInvitations = withAccess(
  pgTable(
    'organisation_invitation',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
      email: text('email'),
      codeHash: text('code_hash'),
      invitedBy: text('invited_by').references(() => users.id, { onDelete: 'set null' }),
      createdAt: timestamp('created_at').defaultNow().notNull(),
      expiresAt: timestamp('expires_at').notNull()
    },
    t => [
      // Exactly one recipient, and a code exactly when the recipient is an email address.
      check('organisation_invitation_recipient', sql`(${t.userId} is null) <> (${t.email} is null)`),
      check('organisation_invitation_code', sql`(${t.email} is null) = (${t.codeHash} is null)`),
      uniqueIndex('organisation_invitation_organisation_user').on(t.organisationId, t.userId),
      uniqueIndex('organisation_invitation_organisation_email').on(t.organisationId, sql`lower(${t.email})`),
      index('organisation_invitation_user_idx').on(t.userId)
    ]
  ),
  t => ({
    name: 'organisationInvitations',
    scope: organisations.$access.scope.via(t.organisationId),
    actions: { read: ['select'], create: ['insert'], cancel: ['delete'] },
    roles: {
      admin: {
        label: 'Administrator',
        permissions: ['read', 'create', 'cancel'],
        assignableScopes: ['organisation'],
        includedIn: [organisationAdmin]
      }
    }
  })
);
