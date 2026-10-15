import { roleAssignments } from '@conservationtv/umbrella';
import { account, deviceCode, passkey, session, verification } from './auth-schema.ts';

// Everything drizzle-kit migrates: Better Auth's tables, umbrella's grants table, and the access definitions.
// Request sessions reach only the protected tables; the rest belong to Better Auth, on the admin connection.
export { account, deviceCode as deviceCodes, passkey as passkeys, roleAssignments, session, verification };
export * from './organisation-schema.ts';
export * from './topology-schema.ts';
