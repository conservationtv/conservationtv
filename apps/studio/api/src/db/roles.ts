import { role } from '@conservationtv/umbrella';

// Shared roles are stored by name in grants, so treat these names like column names.

/** Granted to each account at its own `user` scope when it is created. Never grant it at the global scope. */
export const self = role('self', {
  label: 'Account owner',
  description: 'Read and edit your own account, and everything that belongs to it.',
  assignableScopes: ['user']
});

/**
 * The operators of the whole service, granted at the global scope by trusted code only: nothing grants it on
 * sign-up or invitation. Reaches only the tables that opt in.
 */
export const globalAdmin = role('globalAdmin', {
  label: 'Global administrator',
  description: 'Operate the service: delete any organisation.',
  assignableScopes: ['global']
});

/** Granted at an organisation to every member: the organisation and its member directory. */
export const organisationMember = role('organisationMember', {
  label: 'Member',
  description: 'See the organisation and its members.',
  assignableScopes: ['organisation']
});

/** Granted alongside `organisationMember` to the people who run an organisation. */
export const organisationAdmin = role('organisationAdmin', {
  label: 'Administrator',
  description: 'Manage the organisation, its members, their profiles and its invitations.',
  assignableScopes: ['organisation']
});
