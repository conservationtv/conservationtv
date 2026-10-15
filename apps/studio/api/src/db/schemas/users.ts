import { resourceScope, withAccess } from '@conservationtv/umbrella';
import { self } from '../roles.ts';
import { user } from './auth.ts';

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
