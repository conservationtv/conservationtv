import { defineConfig } from 'drizzle-kit';

// `pnpm db:generate` writes a migration to drizzle/. The agent applies them to its own database when it starts; a
// bundled agent's host ships the folder beside it.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
  strict: true
});
