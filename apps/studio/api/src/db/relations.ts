import { defineRelations } from 'drizzle-orm';
import * as schema from './schema.ts';

/**
 * Relational queries (`db.query`), keyed by schema.ts's export names. Better Auth's generated `authRelations` names
 * its tables by model instead, so its relations are declared here too, against the protected `users` table.
 *
 * Request sessions run these queries under row-level security: related rows the principal cannot read are left out,
 * so every `one` stays optional. Members read each other's profiles, for instance, but not their accounts or
 * memberships.
 */
export const relations = defineRelations(schema, r => ({
  users: {
    sessions: r.many.session({ from: r.users.id, to: r.session.userId }),
    accounts: r.many.account({ from: r.users.id, to: r.account.userId }),
    passkeys: r.many.passkeys({ from: r.users.id, to: r.passkeys.userId }),
    memberships: r.many.organisationMemberships({ from: r.users.id, to: r.organisationMemberships.userId }),
    profiles: r.many.organisationProfiles({ from: r.users.id, to: r.organisationProfiles.userId }),
    invitations: r.many.organisationInvitations({ from: r.users.id, to: r.organisationInvitations.userId })
  },
  session: {
    user: r.one.users({ from: r.session.userId, to: r.users.id })
  },
  account: {
    user: r.one.users({ from: r.account.userId, to: r.users.id })
  },
  passkeys: {
    user: r.one.users({ from: r.passkeys.userId, to: r.users.id })
  },
  organisations: {
    memberships: r.many.organisationMemberships({
      from: r.organisations.id,
      to: r.organisationMemberships.organisationId
    }),
    profiles: r.many.organisationProfiles({ from: r.organisations.id, to: r.organisationProfiles.organisationId }),
    invitations: r.many.organisationInvitations({
      from: r.organisations.id,
      to: r.organisationInvitations.organisationId
    })
  },
  organisationMemberships: {
    organisation: r.one.organisations({ from: r.organisationMemberships.organisationId, to: r.organisations.id }),
    user: r.one.users({ from: r.organisationMemberships.userId, to: r.users.id }),
    profile: r.one.organisationProfiles({
      from: [r.organisationMemberships.organisationId, r.organisationMemberships.userId],
      to: [r.organisationProfiles.organisationId, r.organisationProfiles.userId]
    })
  },
  organisationProfiles: {
    organisation: r.one.organisations({ from: r.organisationProfiles.organisationId, to: r.organisations.id }),
    user: r.one.users({ from: r.organisationProfiles.userId, to: r.users.id }),
    membership: r.one.organisationMemberships({
      from: [r.organisationProfiles.organisationId, r.organisationProfiles.userId],
      to: [r.organisationMemberships.organisationId, r.organisationMemberships.userId]
    })
  },
  organisationInvitations: {
    organisation: r.one.organisations({ from: r.organisationInvitations.organisationId, to: r.organisations.id }),
    user: r.one.users({ from: r.organisationInvitations.userId, to: r.users.id }),
    inviter: r.one.users({ from: r.organisationInvitations.invitedBy, to: r.users.id })
  }
}));
