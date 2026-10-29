import { defineConfig } from 'drizzle-kit';

// The agent's own SQLite database (src/db/database.ts). `pnpm db:generate` writes a migration into drizzle/ from the
// tables in src/db/schema.ts; the agent applies them when it opens the database, so drizzle/ ships beside it.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
  strict: true
});
