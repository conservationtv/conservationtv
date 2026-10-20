import { convergeSpec } from './schema.ts';
import type { Database } from './database.ts';

// Converge's spec, kept as one JSON string. Converge parses what is restored with its own schema, so a spec saved by
// an older agent that no longer parses fails the start rather than being half-applied.

const ROW = 1;

/** The spec as last saved, or `undefined` if none ever was. */
export async function readSpec<Spec>(database: Database): Promise<Spec | undefined> {
  const rows = await database.select().from(convergeSpec).limit(1);
  const [row] = rows;
  if (row === undefined) return undefined;
  const parsed: unknown = JSON.parse(row.spec);
  // SAFETY: converge parses the restored spec with the system's schema before anything uses it.
  return parsed as Spec;
}

/** Saves `spec` in place of the one saved before. */
export async function writeSpec<Spec>(database: Database, spec: Spec): Promise<void> {
  const text = JSON.stringify(spec);
  const now = new Date();
  const savedAt = now.toISOString();
  await database
    .insert(convergeSpec)
    .values({ id: ROW, spec: text, savedAt })
    .onConflictDoUpdate({ target: convergeSpec.id, set: { spec: text, savedAt } });
}
