import { resourceScope, roleAssignments, withAccess } from '@conservationtv/umbrella';
import { account, deviceCode, passkey, session, user, verification } from './auth-schema.ts';
import { self } from './roles.ts';

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
