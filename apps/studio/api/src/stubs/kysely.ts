// Bundled in place of `kysely` (see vite.config.ts). Better Auth's migration code imports `sql`, but this Worker uses
// the Drizzle adapter and never migrates, so anything that reaches it is a mistake worth failing loudly on.

const unavailable = (): never => {
  throw new Error('kysely is not bundled in the studio API Worker; Better Auth uses the Drizzle adapter here');
};

/** Kysely's `sql` tag, used as a function and as a namespace (`sql.raw`, `sql.ref`, …): every use throws. */
export const sql = new Proxy(unavailable, { get: () => unavailable });
