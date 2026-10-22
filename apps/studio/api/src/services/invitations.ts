import { DrizzleQueryError, and, eq, lte, sql } from 'drizzle-orm';
import pg from 'pg';
import { organisationInvitations, organisations } from '../db/schema.ts';
import { useDB } from '../db/transaction.ts';
import { useEnvironment } from '../env/env.ts';
import { ApiFailure } from '../errors.ts';
import { invitationDelivery } from '../organisations/delivery.ts';

// Invitations to organisations. Administrators' side runs in their request session: creating and cancelling one
// changes no grants, so row-level security alone decides who may. The invitee's side is trusted code, because an
// emailed invitation belongs to no account until someone presents its code.

/** How long an invitation stays open. */
const INVITATION_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;

export interface EmailRecipient {
  email: string;
}
export interface AccountRecipient {
  userId: string;
}
export type Recipient = EmailRecipient | AccountRecipient;

export interface NewInvitation {
  recipient: Recipient;
  invitedBy: string;
  /** The one-time code an emailed invitation's link carries (`invitationCode`); none for one to an account. */
  code: string | null;
}

export interface InvitationProof {
  /** The one-time code from the invitation's link; not needed for an invitation to a known account. */
  code?: string;
}

/** Where an emailed invitation is sent, and what it says. */
export interface InvitationLetter {
  email: string;
  organisationName: string;
  code: string;
}

const toHex = (bytes: ArrayBuffer | Uint8Array) =>
  Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');

/** A one-time code for an emailed invitation: 256 random bits, the only secret, as invitation IDs are not. */
export function invitationCode() {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

async function hashCode(code: string) {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code)));
}

const open = sql`${organisationInvitations.expiresAt} > now()`;

/** Delete the organisation's expired invitations to the recipient, which a new one replaces. */
export async function deleteExpiredInvitations(organisationId: string, recipient: Recipient) {
  const db = useDB();
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
}

/**
 * Invite the recipient to the organisation, open for `INVITATION_LIFETIME_MS`, reporting which rule refused it, if one
 * did: row-level security (`forbidden`) to anyone but an administrator, a unique index (`already_invited`) to a second
 * open invitation to the same recipient, or a foreign key (`account_not_found`) to an account that is not there.
 */
export async function createInvitation(organisationId: string, payload: NewInvitation) {
  const db = useDB();
  const environment = useEnvironment();
  const { recipient } = payload;
  const values = {
    organisationId,
    ...('email' in recipient ? { email: recipient.email } : { userId: recipient.userId }),
    codeHash: payload.code === null ? null : await hashCode(payload.code),
    invitedBy: payload.invitedBy,
    expiresAt: new Date(environment.clock() + INVITATION_LIFETIME_MS)
  };
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
    // Drizzle wraps the driver's error.
    const state =
      error instanceof DrizzleQueryError && error.cause instanceof pg.DatabaseError ? error.cause.code : undefined;
    if (state === '42501') throw new ApiFailure('forbidden', { cause: error });
    if (state === '23505') throw new ApiFailure('already_invited', { cause: error });
    if (state === '23503') throw new ApiFailure('account_not_found', { cause: error });
    throw error;
  }
}

/** Send an emailed invitation its link, carrying its one-time code, to the web app's page for it. */
export async function sendInvitation(invitationId: string, letter: InvitationLetter) {
  const environment = useEnvironment();
  const link = new URL(`/invitations/${invitationId}`, environment.variables.WEB_ORIGINS[0]);
  link.searchParams.set('code', letter.code);
  const deliver = invitationDelivery(environment.variables.OTP_DELIVERY);
  await deliver({ email: letter.email, organisationName: letter.organisationName, link: link.href });
}

/** An open invitation, for the page its link opens: readable by anyone who has the link. Trusted code. */
export async function getOpenInvitation(invitationId: string) {
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
  return row;
}

/** The user's open invitations to their account, oldest first. Trusted code. */
export function listOwnInvitations(userId: string) {
  const db = useDB({ trusted: true });
  return db
    .select({
      id: organisationInvitations.id,
      organisation: { id: organisations.id, name: organisations.name },
      expiresAt: organisationInvitations.expiresAt
    })
    .from(organisationInvitations)
    .innerJoin(organisations, eq(organisations.id, organisationInvitations.organisationId))
    .where(and(eq(organisationInvitations.userId, userId), open))
    .orderBy(organisationInvitations.id);
}

/**
 * Lock an open invitation the user may redeem: theirs by account, or any emailed one whose code they present.
 * Anything else is `not_found`, so a wrong guess learns nothing; a wrong code is reported as such. Trusted code.
 */
export async function lockRedeemableInvitation(invitationId: string, userId: string, proof: InvitationProof) {
  const db = useDB({ trusted: true });
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
    if (invitation.userId !== userId) throw new ApiFailure('not_found');
  } else if (proof.code === undefined || (await hashCode(proof.code)) !== invitation.codeHash) {
    throw new ApiFailure('invalid_invitation_code');
  }
  if (invitation.expired) throw new ApiFailure('invitation_expired');
  return invitation;
}

/** The organisation's open and expired invitations, oldest first: its administrators see them, others none. */
export function listOrganisationInvitations(organisationId: string) {
  const db = useDB();
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
}

/** Delete one of the organisation's invitations: `not_found` when the write reaches no row. */
export async function deleteInvitation(organisationId: string, invitationId: string) {
  const db = useDB();
  const deleted = await db
    .delete(organisationInvitations)
    .where(
      and(eq(organisationInvitations.id, invitationId), eq(organisationInvitations.organisationId, organisationId))
    )
    .returning({ id: organisationInvitations.id });
  if (deleted.length === 0) throw new ApiFailure('not_found');
}
