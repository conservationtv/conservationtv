import { resourceScope, roleAssignments, withAccess } from '@conservationtv/umbrella';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid
} from 'drizzle-orm/pg-core';
import { account, deviceCode, passkey, session, user, verification } from './auth-schema.ts';
import { globalAdmin, organisationAdmin, organisationMember, self } from './roles.ts';

// Everything drizzle-kit migrates: Better Auth's tables, umbrella's grants table, and the access definitions.
// Request sessions reach only the protected tables; the rest belong to Better Auth, on the admin connection.
export { account, deviceCode as deviceCodes, passkey as passkeys, roleAssignments, session, verification };

/**
 * Better Auth's user table, protected: each account is its own `user` scope. Email and verification change only
 * through Better Auth; the account owner may read the row and edit its profile fields.
 */
export const users = withAccess(user, t => ({
  name: 'users',
  scope: resourceScope({ name: 'user', key: t.id }),
  immutable: [t.email, t.emailVerified, t.createdAt],
  actions: { read: ['select'], edit: ['update'] },
  roles: {
    owner: {
      label: 'Account owner',
      permissions: ['read', 'edit'],
      assignableScopes: ['user'],
      includedIn: [self]
    }
  }
}));

/**
 * Each organisation is its own `organisation` scope. Members may read it, its administrators rename it,
 * and only global administrators delete it. Creating and deleting organisations are trusted operations
 * (src/organisations/); `remove` is declared so that they can ask umbrella who may, but the application role has no
 * `delete` privilege.
 */
export const organisations = withAccess(
  pgTable('organisation', {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    name: text('name').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull()
  }),
  t => ({
    name: 'organisations',
    scope: resourceScope({ name: 'organisation', key: t.id }),
    immutable: [t.createdAt],
    actions: { read: ['select'], edit: ['update'], remove: ['delete'] },
    roles: {
      member: {
        label: 'Member',
        permissions: ['read'],
        assignableScopes: ['organisation'],
        includedIn: [organisationMember]
      },
      admin: {
        label: 'Administrator',
        permissions: ['read', 'edit'],
        assignableScopes: ['organisation'],
        includedIn: [organisationAdmin]
      },
      globalAdmin: {
        label: 'Global administrator',
        permissions: ['read', 'remove'],
        assignableScopes: ['global'],
        includedIn: [globalAdmin]
      }
    }
  })
);

/**
 * Who belongs to an organisation. Members read every membership of their organisations, and everyone reads their own.
 * Joining is an accepted invitation (`organisationInvitations`). Every write here is trusted code, because joining and
 * leaving change grants in the same transaction: `remove` is declared so those operations can ask umbrella who may,
 * and the application role has only `select`.
 */
export const organisationMemberships = withAccess(
  pgTable(
    'organisation_membership',
    {
      id: uuid('id')
        .primaryKey()
        .default(sql`uuidv7()`),
      organisationId: uuid('organisation_id')
        .notNull()
        .references(() => organisations.id, { onDelete: 'cascade' }),
      userId: text('user_id')
        .notNull()
        .references(() => users.id, { onDelete: 'cascade' }),
      createdAt: timestamp('created_at').defaultNow().notNull()
    },
    t => [
      unique('organisation_membership_organisation_user').on(t.organisationId, t.userId),
      index('organisation_membership_user_idx').on(t.userId)
    ]
  ),
  t => ({
    name: 'organisationMemberships',
    scopes: {
      organisation: organisations.$access.scope.via(t.organisationId),
      account: users.$access.scope.via(t.userId)
    },
    immutable: [t.createdAt],
    actions: { read: ['select'], remove: ['delete'] },
    roles: {
      own: {
        label: 'Own memberships',
        permissions: ['read'],
        assignableScopes: ['user'],
        includedIn: [self]
      },
      directory: {
        label: 'Member directory',
        permissions: ['read'],
        assignableScopes: ['organisation'],
        includedIn: [organisationMember]
      },
      admin: {
        label: 'Administrator',
        permissions: ['read', 'remove'],
        assignableScopes: ['organisation'],
        includedIn: [organisationAdmin]
      }
    }
  })
);

/**
 * What an organisation's members see of each other: one per membership, created on joining and deleted with
 * the membership. The account behind it stays private. Members read the directory; each person edits their own
 * profiles, and administrators edit any in their organisation.
 */
export const organisationProfiles = withAccess(
  pgTable(
    'organisation_profile',
    {
      organisationId: uuid('organisation_id').notNull(),
      userId: text('user_id').notNull(),
      displayName: text('display_name').notNull()
    },
    t => [
      primaryKey({ columns: [t.organisationId, t.userId] }),
      foreignKey({
        name: 'organisation_profile_membership_fk',
        columns: [t.organisationId, t.userId],
        foreignColumns: [organisationMemberships.organisationId, organisationMemberships.userId]
      }).onDelete('cascade'),
      index('organisation_profile_user_idx').on(t.userId)
    ]
  ),
  t => ({
    name: 'organisationProfiles',
    scopes: {
      organisation: organisations.$access.scope.via(t.organisationId),
      account: users.$access.scope.via(t.userId)
    },
    actions: { read: ['select'], edit: ['update'] },
    roles: {
      owner: {
        label: 'Own profiles',
        permissions: ['read', 'edit'],
        assignableScopes: ['user'],
        includedIn: [self]
      },
      directory: {
        label: 'Member directory',
        permissions: ['read'],
        assignableScopes: ['organisation'],
        includedIn: [organisationMember]
      },
      admin: {
        label: 'Administrator',
        permissions: ['read', 'edit'],
        assignableScopes: ['organisation'],
        includedIn: [organisationAdmin]
      }
    }
  })
);

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
