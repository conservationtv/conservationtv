import { user, type Access } from '@conservationtv/umbrella';
import { and, eq, sql } from 'drizzle-orm';
import { authorization } from '../access.ts';
import type { Database } from '../db/client.ts';
import { organisationAdmin, organisationMember } from '../db/roles.ts';
import { organisationMemberships, organisationProfiles, organisations } from '../db/schema.ts';
import { ApiFailure } from '../errors.ts';
import type { UserPrincipal } from '../middleware/principal.ts';
import { useServices } from '../services.ts';

// Joining and leaving change rows and grants together, so every write here is trusted code on the admin connection,
// in one transaction. Who may make each change is still the access definitions' decision: `inspect` asks them before
// the write, and the application role has no privilege to make these writes itself.

export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface NewOrganisation {
  name: string;
  /** The creator's name in the organisation's directory. */
  displayName: string;
}
export interface NewMember {
  organisationId: string;
  /** The member's name in the organisation's directory. */
  displayName: string;
}

export const organisationScope = (organisationId: string) => organisations.$access.scope.at(organisationId);

export async function trusted<Result>(run: (tx: Transaction, access: Access) => Promise<Result>) {
  const services = useServices();
  const admin = await services.admin();
  return admin.transaction(tx => run(tx, authorization.access(tx)));
}

/** Make the principal a member: the membership, its profile and the member grant. Inside a trusted transaction. */
export async function addMember(tx: Transaction, access: Access, principal: UserPrincipal, input: NewMember) {
  const [membership] = await tx
    .insert(organisationMemberships)
    .values({ organisationId: input.organisationId, userId: principal.id })
    .onConflictDoNothing()
    .returning({
      organisationId: organisationMemberships.organisationId,
      userId: organisationMemberships.userId,
      joinedAt: organisationMemberships.createdAt
    });
  if (!membership) throw new ApiFailure('already_member');
  await tx
    .insert(organisationProfiles)
    .values({ organisationId: input.organisationId, userId: principal.id, displayName: input.displayName });
  await access.at(organisationScope(input.organisationId)).grant({ principal, role: organisationMember });
  return membership;
}

/**
 * Lock the organisation for the rest of the transaction, so concurrent changes to its administrators are serialised,
 * and fail as `notFound` unless the principal can see it.
 */
async function lockVisibleOrganisation(
  tx: Transaction,
  access: Access,
  principal: UserPrincipal,
  organisationId: string
) {
  const [row] = await tx
    .select({ id: organisations.id })
    .from(organisations)
    .where(eq(organisations.id, organisationId))
    .for('update');
  const decision = await access.inspect({
    principal,
    resource: organisations,
    scope: organisationScope(organisationId)
  });
  if (!row || !decision.permissions.read?.allowed) throw new ApiFailure('not_found');
}

async function mayRemoveMembers(access: Access, principal: UserPrincipal, organisationId: string) {
  const decision = await access.inspect({
    principal,
    resource: organisationMemberships,
    scope: organisationScope(organisationId)
  });
  return decision.permissions.remove?.allowed ?? false;
}

/** Create an organisation with the principal as its first member and administrator. */
export function createOrganisation(principal: UserPrincipal, input: NewOrganisation) {
  return trusted(async (tx, access) => {
    const [organisation] = await tx
      .insert(organisations)
      .values({ name: input.name })
      .returning({ id: organisations.id, name: organisations.name, createdAt: organisations.createdAt });
    await addMember(tx, access, principal, { organisationId: organisation!.id, displayName: input.displayName });
    await access.at(organisationScope(organisation!.id)).grant({ principal, role: organisationAdmin });
    return organisation!;
  });
}

/** Organisation administrators only: the caller must hold an active `organisationAdmin` grant there. */
async function requireAdmin(access: Access, principal: UserPrincipal, organisationId: string) {
  const held = await access.grantsQuery({
    principal,
    role: organisationAdmin,
    scope: organisationScope(organisationId),
    active: true
  });
  if (held.length === 0) throw new ApiFailure('forbidden');
}

/** Refuse to take the last active administrator away: the member may hold it only if someone else does too. */
async function keepAnotherAdmin(access: Access, organisationId: string, memberId: string) {
  const member = user(memberId);
  const admins = await access.grantsQuery({
    role: organisationAdmin,
    scope: organisationScope(organisationId),
    active: true
  });
  const isAdmin = admins.some(grant => grant.principalKind === member.kind && grant.principalId === member.id);
  if (isAdmin && !admins.some(grant => grant.principalKind !== member.kind || grant.principalId !== member.id))
    throw new ApiFailure('last_admin');
}

/**
 * End a membership: an administrator removing someone, or the principal leaving. Its grants go with it, and its
 * profile by cascade. The last administrator cannot be removed.
 */
export function endMembership(principal: UserPrincipal, organisationId: string, memberId: string) {
  return trusted(async (tx, access) => {
    // Anyone may end their own membership; ending someone else's needs the remove permission. Either way the
    // organisation must keep an administrator other than the member leaving, counting only active grants.
    await lockVisibleOrganisation(tx, access, principal, organisationId);
    const [membership] = await tx
      .select()
      .from(organisationMemberships)
      .where(
        and(eq(organisationMemberships.organisationId, organisationId), eq(organisationMemberships.userId, memberId))
      );
    if (!membership) throw new ApiFailure('not_found');
    const leaving = membership.userId === principal.id;
    if (!leaving && !(await mayRemoveMembers(access, principal, organisationId))) throw new ApiFailure('forbidden');

    await keepAnotherAdmin(access, organisationId, membership.userId);

    // Every role they hold here, not just the ones membership grants.
    await access.at(organisationScope(organisationId)).revoke({ principal: user(membership.userId) });
    await tx.delete(organisationMemberships).where(eq(organisationMemberships.id, membership.id));
  });
}

/** Delete an organisation, everyone's grants at it, and by cascade its memberships, profiles and invitations. */
export function deleteOrganisation(principal: UserPrincipal, organisationId: string) {
  return trusted(async (tx, access) => {
    await lockVisibleOrganisation(tx, access, principal, organisationId);
    const decision = await access.inspect({
      principal,
      resource: organisations,
      scope: organisationScope(organisationId)
    });
    if (!decision.permissions.remove?.allowed) throw new ApiFailure('forbidden');
    await access.at(organisationScope(organisationId)).all.revoke();
    await tx.delete(organisations).where(eq(organisations.id, organisationId));
  });
}

/**
 * Make a member an administrator of the organisation: organisation administrators only. Granting the role again is
 * harmless. Locks the organisation, as every change to its administrators does.
 */
export function grantAdmin(principal: UserPrincipal, organisationId: string, memberId: string) {
  return trusted(async (tx, access) => {
    await lockVisibleOrganisation(tx, access, principal, organisationId);
    await requireAdmin(access, principal, organisationId);
    const [membership] = await tx
      .select({ userId: organisationMemberships.userId })
      .from(organisationMemberships)
      .where(
        and(eq(organisationMemberships.organisationId, organisationId), eq(organisationMemberships.userId, memberId))
      );
    if (!membership) throw new ApiFailure('not_found');
    await access
      .at(organisationScope(organisationId))
      .grant({ principal: user(membership.userId), role: organisationAdmin });
  });
}

/**
 * Take a member's administrator role away, leaving their membership: organisation administrators only, themselves
 * included. The last administrator keeps it. Revoking it from someone who doesn't hold it changes nothing.
 */
export function revokeAdmin(principal: UserPrincipal, organisationId: string, memberId: string) {
  return trusted(async (tx, access) => {
    await lockVisibleOrganisation(tx, access, principal, organisationId);
    await requireAdmin(access, principal, organisationId);
    const [membership] = await tx
      .select({ userId: organisationMemberships.userId })
      .from(organisationMemberships)
      .where(
        and(eq(organisationMemberships.organisationId, organisationId), eq(organisationMemberships.userId, memberId))
      );
    if (!membership) throw new ApiFailure('not_found');
    await keepAnotherAdmin(access, organisationId, membership.userId);
    await access
      .at(organisationScope(organisationId))
      .revoke({ principal: user(membership.userId), role: organisationAdmin });
  });
}

/** A role a member holds at the organisation, as umbrella's catalog names it. */
export interface MemberRole {
  id: string;
  label: string;
}

/**
 * The organisation's members visible to the principal, with their profiles and the roles they hold there, one row
 * each, aggregated in Postgres (umbrella's GUIDE: "One row per user, aggregated in SQL"). It runs in the principal's
 * request session: row-level security decides which members appear, and the grants table, readable by request
 * sessions (see the `grantsReadable` migration), only adds their roles.
 */
export async function listMembers(principal: UserPrincipal, organisationId: string) {
  const services = useServices();
  const session = await services.session(principal);
  return session.transaction(tx => {
    const roles = authorization
      .access(tx)
      .grantsQuery({ scope: organisationScope(organisationId), active: true })
      .as('member_roles');
    return tx
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
  });
}

/** The principal's organisations, each with the roles they hold there, aggregated as `listMembers` is, in their session. */
export async function listOwnOrganisations(principal: UserPrincipal) {
  const services = useServices();
  const session = await services.session(principal);
  return session.transaction(tx => {
    const roles = authorization.access(tx).grantsQuery({ principal, active: true }).as('own_roles');
    return tx
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
        and(
          eq(organisationMemberships.organisationId, organisations.id),
          eq(organisationMemberships.userId, principal.id)
        )
      )
      .leftJoin(roles, and(eq(roles.scopeName, 'organisation'), eq(roles.scopeId, sql`${organisations.id}::text`)))
      .groupBy(organisations.id)
      .orderBy(organisations.id);
  });
}
