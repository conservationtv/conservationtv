import { fileURLToPath } from 'node:url';

// The agent's database migrations (apps/agent/core/drizzle), found from where this module runs: src/ under tsx, or
// dist/ once esbuild bundles it into index.js, both one level below the runner's package, so the same relative path
// finds them in a checkout. The image copies them beside its bundle and sets AGENT_MIGRATIONS_DIR instead.
export const CHECKOUT_MIGRATIONS = fileURLToPath(new URL('../../core/drizzle', import.meta.url));
