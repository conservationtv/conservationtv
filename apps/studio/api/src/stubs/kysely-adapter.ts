// Bundled in place of `@better-auth/kysely-adapter` (see vite.config.ts). Better Auth imports it unconditionally, but
// with the Drizzle adapter it only asks `getKyselyDatabaseType`, which answers null for anything that isn't a Kysely
// database or dialect. The rest is the Kysely adapter and its migrations, which this Worker never uses.

const unavailable = (): never => {
  throw new Error('The Kysely adapter is not bundled in the studio API Worker; Better Auth uses the Drizzle adapter');
};

/** No Kysely database type: the configured database is the Drizzle adapter. */
export const getKyselyDatabaseType = (): null => null;
export const createKyselyAdapter = unavailable;
export const kyselyAdapter = unavailable;
export const getMssqlSchema = unavailable;
export const getPostgresSchema = unavailable;
export const toIntrospectedTables = unavailable;
export const toPhysicalSchema = unavailable;
