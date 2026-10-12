import { defineConfig } from 'drizzle-kit';
import { LOCAL_DATABASE_URL } from './src/db/local.ts';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? LOCAL_DATABASE_URL },
  strict: true
});
