import { DrizzleQueryError, and, eq, lte, sql } from 'drizzle-orm';
import pg from 'pg';
import { organisationInvitations, organisations } from '../db/schema.ts';
import { ApiFailure } from '../errors.ts';
import { transaction, trustedTransaction, useDB } from '../db/transaction.ts';
import { useUser } from '../middleware/principal.ts';
import { useEnvironment } from '../env/env.ts';
import { invitationDelivery } from './delivery.ts';
import { addMember } from './membership.ts';

// Administrators' side of invitations runs in their request session: creating and cancelling one changes no grants,
// so row-level security alone decides who may. The invitee's side is trusted code, because an emailed invitation
// belongs to no account until someone presents its code.

/** How long an invitation stays open. */
const INVITATION_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;

export interface EmailRecipient {
  email: string;
}
export interface AccountRecipient {
  userId: string;
}
export type Recipient = EmailRecipient | AccountRecipient;

export interface InvitationProof {
  /** The one-time code from the invitation's link; not needed for an invitation to a known account. */
  code?: string;
}
export interface Acceptance extends InvitationProof {
  /** The new member's name in the organisation's directory. */
  displayName: string;
}

const toHex = (bytes: ArrayBuffer | Uint8Array) =>
  Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');

/** 256 random bits: the code is the only secret, as invitation IDs are not. */
function newCode() {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

async function hashCode(code: string) {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code)));
}

const open = sql`${organisationInvitations.expiresAt} > now()`;

type NewInvitation = typeof organisationInvitations.$inferInsert;

/** Insert through the request session, reporting which rule refused the row, if one did. */
async function insertInvitation(values: NewInvitation) {
  const db = useDB();
  try {
    // Never `codeHash`: the application role cannot read it back.
    const [row] = await db.insert(organisationInvitations).values(values).returning({
      id: organisationInvitations.id,
      email: organisationInvitations.email,
      userId: organisationInvitations.userId,
      invitedBy: organisationInvitations.invitedBy,
      createdAt: organisationInvitations.createdAt,
      expiresAt: organisationInvitations.expiresAt
    });
    return row!;
  } catch (error) {
    // Drizzle wraps the driver's error: row-level security, a unique index, or the invited account's foreign key.
    const state =
      error instanceof DrizzleQueryError && error.cause instanceof pg.DatabaseError ? error.cause.code : undefined;
    if (state === '42501') throw new ApiFailure('forbidden', { cause: error });
    if (state === '23505') throw new ApiFailure('already_invited', { cause: error });
    if (state === '23503') throw new ApiFailure('account_not_found', { cause: error });
    throw error;
  }
}

/**
 * Invite someone to an organisation the user administers. An emailed invitation is sent a link with a one-time
 * code; an invitation to an account is found by that account under `/invitations`. An expired invitation to the same
 * recipient is replaced.
 */
export async function createInvitation(organisationId: string, recipient: Recipient) {
  const environment = useEnvironment();
  const principal = useUser();
  const code = 'email' in recipient ? newCode() : null;
  const values = {
    organisationId,
    ...('email' in recipient ? { email: recipient.email } : { userId: recipient.userId }),
    codeHash: code === null ? null : await hashCode(code),
    invitedBy: principal.id,
    expiresAt: new Date(environment.clock() + INVITATION_LIFETIME_MS)
  };
  const { invitation, organisationName } = await transaction(async () => {
    const db = useDB();
    // Hidden organisations are not found. Row-level security refuses the insert to anyone but an administrator, and
    // the unique indexes refuse a second open invitation to the same recipient.
    const [organisation] = await db
      .select({ name: organisations.name })
      .from(organisations)
      .where(eq(organisations.id, organisationId));
    if (!organisation) throw new ApiFailure('not_found');
    if ('userId' in recipient) {
      const member = await db.query.organisationMemberships.findFirst({
        columns: { id: true },
        where: { organisationId, userId: recipient.userId }
      });
      if (member) throw new ApiFailure('already_member');
    }
    await db
      .delete(organisationInvitations)
      .where(
        and(
          eq(organisationInvitations.organisationId, organisationId),
          'email' in recipient
            ? sql`lower(${organisationInvitations.email}) = lower(${recipient.email})`
            : eq(organisationInvitations.userId, recipient.userId),
          lte(organisationInvitations.expiresAt, sql`now()`)
        )
      );
    const row = await insertInvitation(values);
    return { invitation: row, organisationName: organisation.name };
  });
  if (code !== null && invitation.email !== null) {
    const link = new URL(`/invitations/${invitation.id}`, environment.variables.WEB_ORIGINS[0]);
    link.searchParams.set('code', code);
    await invitationDelivery(environment.variables.OTP_DELIVERY)({
      email: invitation.email,
      organisationName,
      link: link.href
    });
  }
  return invitation;
}

/** An open invitation by its ID, for the page its link opens: readable by anyone who has the link. */
export function readInvitation(invitationId: string) {
  return trustedTransaction(async () => {
    const db = useDB({ trusted: true });
    const [row] = await db
      .select({
        id: organisationInvitations.id,
        organisation: { id: organisations.id, name: organisations.name },
        needsCode: sql<boolean>`${organisationInvitations.userId} is null`,
        expiresAt: organisationInvitations.expiresAt
      })
      .from(organisationInvitations)
      .innerJoin(organisations, eq(organisations.id, organisationInvitations.organisationId))
      .where(and(eq(organisationInvitations.id, invitationId), open));
    if (!row) throw new ApiFailure('not_found');
    return row;
  });
}

/** The user's open invitations to their account. Emailed invitations are reached through their links instead. */
export function listOwnInvitations() {
  const principal = useUser();
  return trustedTransaction(async () => {
    const db = useDB({ trusted: true });
    return db
      .select({
        id: organisationInvitations.id,
        organisation: { id: organisations.id, name: organisations.name },
        expiresAt: organisationInvitations.expiresAt
      })
      .from(organisationInvitations)
      .innerJoin(organisations, eq(organisations.id, organisationInvitations.organisationId))
      .where(and(eq(organisationInvitations.userId, principal.id), open))
      .orderBy(organisationInvitations.id);
  });
}

/**
 * Lock an open invitation the user may redeem: theirs by account, or any emailed one whose code they present.
 * Anything else is `notFound`, so a wrong guess learns nothing; a wrong code is reported as such.
 */
async function redeemable(invitationId: string, proof: InvitationProof) {
  const db = useDB({ trusted: true });
  const principal = useUser();
  const [invitation] = await db
    .select({
      id: organisationInvitations.id,
      organisationId: organisationInvitations.organisationId,
      userId: organisationInvitations.userId,
      codeHash: organisationInvitations.codeHash,
      expired: sql<boolean>`${organisationInvitations.expiresAt} <= now()`
    })
    .from(organisationInvitations)
    .where(eq(organisationInvitations.id, invitationId))
    .for('update');
  if (!invitation) throw new ApiFailure('not_found');
  if (invitation.userId !== null) {
    if (invitation.userId !== principal.id) throw new ApiFailure('not_found');
  } else if (proof.code === undefined || (await hashCode(proof.code)) !== invitation.codeHash) {
    throw new ApiFailure('invalid_invitation_code');
  }
  if (invitation.expired) throw new ApiFailure('invitation_expired');
  return invitation;
}

/** Join the organisation as the user, using up the invitation. */
export function acceptInvitation(invitationId: string, acceptance: Acceptance) {
  return trustedTransaction(async () => {
    const db = useDB({ trusted: true });
    const invitation = await redeemable(invitationId, acceptance);
    const membership = await addMember({
      organisationId: invitation.organisationId,
      displayName: acceptance.displayName
    });
    await db.delete(organisationInvitations).where(eq(organisationInvitations.id, invitation.id));
    return membership;
  });
}

/** Turn the invitation down, which deletes it. Needs the same proof as accepting. */
export function declineInvitation(invitationId: string, proof: InvitationProof) {
  return trustedTransaction(async () => {
    const db = useDB({ trusted: true });
    const invitation = await redeemable(invitationId, proof);
    await db.delete(organisationInvitations).where(eq(organisationInvitations.id, invitation.id));
  });
}

/** Cancel one of an organisation's invitations: administrators only, by row-level security. */
export async function cancelInvitation(organisationId: string, invitationId: string) {
  const deleted = await transaction(async () => {
    const db = useDB();
    return db
      .delete(organisationInvitations)
      .where(
        and(eq(organisationInvitations.id, invitationId), eq(organisationInvitations.organisationId, organisationId))
      )
      .returning({ id: organisationInvitations.id });
  });
  if (deleted.length === 0) throw new ApiFailure('not_found');
}

/** An organisation's open and expired invitations, for its administrators; others see none. */
export function listOrganisationInvitations(organisationId: string) {
  return transaction(async () => {
    const db = useDB();
    const [organisation] = await db
      .select({ id: organisations.id })
      .from(organisations)
      .where(eq(organisations.id, organisationId));
    if (!organisation) throw new ApiFailure('not_found');
    return db
      .select({
        id: organisationInvitations.id,
        email: organisationInvitations.email,
        userId: organisationInvitations.userId,
        invitedBy: organisationInvitations.invitedBy,
        createdAt: organisationInvitations.createdAt,
        expiresAt: organisationInvitations.expiresAt
      })
      .from(organisationInvitations)
      .where(eq(organisationInvitations.organisationId, organisationId))
      .orderBy(organisationInvitations.id);
  });
}
