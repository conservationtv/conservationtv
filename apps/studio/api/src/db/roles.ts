import { role } from '@conservationtv/umbrella';

// Shared roles are stored by name in grants, so treat these names like column names.

/** Granted to each account at its own `user` scope when it is created. Never grant it at the global scope. */
export const self = role('self', {
  label: 'Account owner',
  description: 'Read and edit your own account, and everything that belongs to it.',
  assignableScopes: ['user']
});
