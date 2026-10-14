import { defineConfig } from 'drizzle-kit';
import { LOCAL_ADMIN_DATABASE_URL } from './src/db/local.ts';

// Migrations run as the owning (admin) role. `pnpm db:generate` runs drizzle-kit and then `umbrella generate`, which
// adds the row-level security policies compiled from src/db/schema.ts as a custom migration.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? LOCAL_ADMIN_DATABASE_URL },
  strict: true
});
