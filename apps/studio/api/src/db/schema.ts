import { roleAssignments } from '@conservationtv/umbrella';
import { account, deviceCode, passkey, session, verification } from './schemas/auth.ts';

// Everything drizzle-kit migrates: Better Auth's tables, umbrella's grants table, and the access definitions in
// schemas/. Request sessions reach only the protected tables; the rest belong to Better Auth, on the admin connection.
export { account, deviceCode as deviceCodes, passkey as passkeys, roleAssignments, session, verification };
export * from './schemas/users.ts';
export * from './schemas/organisations.ts';
export * from './schemas/invitations.ts';
export * from './schemas/networks.ts';
export * from './schemas/devices.ts';
export * from './schemas/agents.ts';
export * from './schemas/streams.ts';
