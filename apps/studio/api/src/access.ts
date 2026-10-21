import { defineAuthorization } from '@conservationtv/umbrella';
import { globalAdmin, organisationAdmin, organisationMember, self } from './db/roles.ts';
import * as schema from './db/schema.ts';

/**
 * The compiled access definitions, once per isolate. Request handlers run in a session over the application
 * connection through `transaction()` (src/db/transaction.ts); only trusted code (Better Auth's provisioning hooks and
 * `trustedTransaction()`, through `useAccess()`) reaches `authorization.access(admin)`.
 */
export const authorization = defineAuthorization({
  schema,
  roles: { self, globalAdmin, organisationMember, organisationAdmin }
});
