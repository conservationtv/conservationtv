import { user } from '@conservationtv/umbrella';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { authorization } from '../access.ts';
import { organisationAdmin, organisationMember } from '../db/roles.ts';
import { organisationInvitations, organisationMemberships, organisationProfiles, organisations } from '../db/schema.ts';
import { useAccess, useDB } from '../db/transaction.ts';
import { ApiFailure } from '../errors.ts';
import { unchanged } from '../topology/transaction.ts';
import { deleteOrganisationBrowsers } from './browsers.ts';

// Organisations, their members and the roles members hold. Reads and profile edits run in whichever transaction the
// caller is in, so in a request session row-level security decides what each account sees. Joining, leaving and
// changing roles change grants as well as rows, which request sessions cannot write, so they are trusted code: the
// `require…` checks ask the access definitions first, as row-level security would, and changes to an organisation's
// administrators lock it first, so they are serialised.

export interface NewOrganisation {
  name: string;
}

export interface OrganisationChanges {
  name: string;
}

export interface NewMember {
  /** The member's name in the organisation's directory. */
  displayName: string;
}

export interface ProfileChanges {
  displayName: string;
}

/** A role a member holds at the organisation, as umbrella's catalog names it. */
export interface MemberRole {
  id: string;
  label: string;
}

export const organisationScope = (organisationId: string) => organisations.$access.scope.at(organisationId);

/** The user's organisations, oldest first, each with the roles they hold there, aggregated in Postgres. */
export function listOwnOrganisations(userId: string) {
  const db = useDB();
  const roles = authorization
    .access(db)
    .grantsQuery({ principal: user(userId), active: true })
    .as('own_roles');
  return db
    .select({
      id: organisations.id,
      name: organisations.name,
      createdAt: organisations.createdAt,
      roles: sql<MemberRole[]>`coalesce(
        json_agg(json_build_object('id', ${roles.roleId}, 'label', ${roles.label}) order by ${roles.roleId})
          filter (where ${roles.id} is not null),
        '[]'
      )`
    })
    .from(organisations)
    .innerJoin(
      organisationMemberships,
      and(eq(organisationMemberships.organisationId, organisations.id), eq(organisationMemberships.userId, userId))
    )
    .leftJoin(roles, and(eq(roles.scopeName, 'organisation'), eq(roles.scopeId, sql`${organisations.id}::text`)))
    .groupBy(organisations.id)
    .orderBy(organisations.id);
}

/** The organisation, if it is visible and not deleted. */
export async function getOrganisation(organisationId: string) {
  const db = useDB();
  const [row] = await db
    .select({ id: organisations.id, name: organisations.name, createdAt: organisations.createdAt })
    .from(organisations)
    .where(and(eq(organisations.id, organisationId), isNull(organisations.deletedAt)));
  return row;
}

/** Create an organisation, with no members yet. Trusted code: its first member is made in the same transaction. */
export async function createOrganisation(payload: NewOrganisation) {
  const db = useDB({ trusted: true });
  const [row] = await db
    .insert(organisations)
    .values({ name: payload.name })
    .returning({ id: organisations.id, name: organisations.name, createdAt: organisations.createdAt });
  return row!;
}

/** Rename the organisation: `forbidden` or `not_found` when the write reaches no row. */
export async function updateOrganisation(organisationId: string, changes: OrganisationChanges) {
  const db = useDB();
  const [row] = await db
    .update(organisations)
    .set({ name: changes.name })
    .where(eq(organisations.id, organisationId))
    .returning({ id: organisations.id, name: organisations.name, createdAt: organisations.createdAt });
  if (!row) throw await unchanged(organisations.id, organisationId);
  return row;
}

/**
 * Delete the organisation softly: revoke every grant at it (its devices' too), delete everything that would give
 * access to it again (its browsers, invitations, and memberships with their profiles), and mark it deleted. Its row,
 * topology and reports stay, so the delete is a few rows however long the organisation has reported; devices of a
 * deleted organisation can no longer authenticate (src/middleware/device.ts).
 */
export async function deleteOrganisation(organisationId: string) {
  const db = useDB({ trusted: true });
  const access = useAccess();
  await access.at(organisationScope(organisationId)).all.revoke();
  await deleteOrganisationBrowsers(organisationId);
  await db.delete(organisationInvitations).where(eq(organisationInvitations.organisationId, organisationId));
  await db.delete(organisationMemberships).where(eq(organisationMemberships.organisationId, organisationId));
  await db
    .update(organisations)
    .set({ deletedAt: sql`now()` })
    .where(eq(organisations.id, organisationId));
}

/**
 * Lock the organisation for the rest of the transaction, so concurrent changes to its administrators are serialised:
 * `not_found` unless the user can see it and it is not deleted.
 */
export async function lockOrganisation(organisationId: string, userId: string) {
  const db = useDB({ trusted: true });
  const access = useAccess();
  const [row] = await db
    .select({ id: organisations.id })
    .from(organisations)
    .where(and(eq(organisations.id, organisationId), isNull(organisations.deletedAt)))
    .for('update');
  const scope = organisationScope(organisationId);
  const decision = await access.inspect({ principal: user(userId), resource: organisations, scope });
  if (!row || !decision.permissions.read?.allowed) throw new ApiFailure('not_found');
}

/** Refuses the user unless they may delete the organisation: `forbidden`. */
export async function requireOrganisationRemoval(organisationId: string, userId: string) {
  const access = useAccess();
  const scope = organisationScope(organisationId);
  const decision = await access.inspect({ principal: user(userId), resource: organisations, scope });
  if (!decision.permissions.remove?.allowed) throw new ApiFailure('forbidden');
}

/**
 * The organisation's members visible to the transaction, longest-standing first, with their profiles and the roles
 * they hold there, one row each, aggregated in Postgres (umbrella's GUIDE: "One row per user, aggregated in SQL"). The
 * grants table, readable by request sessions (see the `grantsReadable` migration), only adds their roles.
 */
export function listMembers(organisationId: string) {
  const db = useDB();
  const roles = authorization
    .access(db)
    .grantsQuery({ scope: organisationScope(organisationId), active: true })
    .as('member_roles');
  return db
    .select({
      userId: organisationMemberships.userId,
      displayName: organisationProfiles.displayName,
      joinedAt: organisationMemberships.createdAt,
      roles: sql<MemberRole[]>`coalesce(
        json_agg(json_build_object('id', ${roles.roleId}, 'label', ${roles.label}) order by ${roles.roleId})
          filter (where ${roles.id} is not null),
        '[]'
      )`
    })
    .from(organisationMemberships)
    .leftJoin(
      organisationProfiles,
      and(
        eq(organisationProfiles.organisationId, organisationMemberships.organisationId),
        eq(organisationProfiles.userId, organisationMemberships.userId)
      )
    )
    .leftJoin(roles, and(eq(roles.principalKind, 'user'), eq(roles.principalId, organisationMemberships.userId)))
    .where(eq(organisationMemberships.organisationId, organisationId))
    .groupBy(organisationMemberships.id, organisationProfiles.displayName)
    .orderBy(organisationMemberships.id);
}

/** The user's membership of the organisation, if they have one visible to the transaction. */
export function getMembership(organisationId: string, userId: string) {
  const db = useDB();
  return db.query.organisationMemberships.findFirst({
    columns: { id: true, userId: true },
    where: { organisationId, userId }
  });
}

/** Make the user a member: the membership, its profile and the member grant. `already_member` if they are one. */
export async function addMember(organisationId: string, userId: string, payload: NewMember) {
  const db = useDB({ trusted: true });
  const access = useAccess();
  const [membership] = await db
    .insert(organisationMemberships)
    .values({ organisationId, userId })
    .onConflictDoNothing()
    .returning({
      organisationId: organisationMemberships.organisationId,
      userId: organisationMemberships.userId,
      joinedAt: organisationMemberships.createdAt
    });
  if (!membership) throw new ApiFailure('already_member');
  await db.insert(organisationProfiles).values({ organisationId, userId, displayName: payload.displayName });
  await access.at(organisationScope(organisationId)).grant({ principal: user(userId), role: organisationMember });
  return membership;
}

/** Change how the organisation's members see the user: their own profile, if it is visible. */
export async function updateProfile(organisationId: string, userId: string, changes: ProfileChanges) {
  const db = useDB();
  const [row] = await db
    .update(organisationProfiles)
    .set({ displayName: changes.displayName })
    .where(and(eq(organisationProfiles.organisationId, organisationId), eq(organisationProfiles.userId, userId)))
    .returning({ userId: organisationProfiles.userId, displayName: organisationProfiles.displayName });
  return row;
}

/**
 * End the user's membership, with every role they hold at the organisation, not only the ones membership grants. Its
 * profile goes by cascade; their browsers there, which refer to it, must go first (src/services/browsers.ts).
 */
export async function endMembership(organisationId: string, userId: string) {
  const db = useDB({ trusted: true });
  const access = useAccess();
  await access.at(organisationScope(organisationId)).revoke({ principal: user(userId) });
  await db
    .delete(organisationMemberships)
    .where(and(eq(organisationMemberships.organisationId, organisationId), eq(organisationMemberships.userId, userId)));
}

/** Refuses the user unless they may remove the organisation's members: `forbidden`. */
export async function requireMemberRemoval(organisationId: string, userId: string) {
  const access = useAccess();
  const scope = organisationScope(organisationId);
  const decision = await access.inspect({ principal: user(userId), resource: organisationMemberships, scope });
  if (!decision.permissions.remove?.allowed) throw new ApiFailure('forbidden');
}

/** Refuses the user unless they hold an active administrator grant at the organisation: `forbidden`. */
export async function requireAdmin(organisationId: string, userId: string) {
  const access = useAccess();
  const scope = organisationScope(organisationId);
  const held = await access.grantsQuery({ principal: user(userId), role: organisationAdmin, scope, active: true });
  if (held.length === 0) throw new ApiFailure('forbidden');
}

/** Refuses to take the last active administrator away: `last_admin` unless someone besides the user holds it too. */
export async function keepAnotherAdmin(organisationId: string, userId: string) {
  const access = useAccess();
  const member = user(userId);
  const admins = await access.grantsQuery({
    role: organisationAdmin,
    scope: organisationScope(organisationId),
    active: true
  });
  const isAdmin = admins.some(grant => grant.principalKind === member.kind && grant.principalId === member.id);
  if (isAdmin && !admins.some(grant => grant.principalKind !== member.kind || grant.principalId !== member.id))
    throw new ApiFailure('last_admin');
}

/** Make the user an administrator of the organisation. Granting it again is harmless. */
export async function grantAdmin(organisationId: string, userId: string) {
  const access = useAccess();
  await access.at(organisationScope(organisationId)).grant({ principal: user(userId), role: organisationAdmin });
}

/** Take the user's administrator role away, leaving their membership. Revoking what they don't hold changes nothing. */
export async function revokeAdmin(organisationId: string, userId: string) {
  const access = useAccess();
  await access.at(organisationScope(organisationId)).revoke({ principal: user(userId), role: organisationAdmin });
}
