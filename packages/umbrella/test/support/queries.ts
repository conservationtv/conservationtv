import { getColumns, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Database, Principal } from '../../src/index.js';
import type { AnyProtectedTable } from '../../src/definitions.js';
import type { Harness } from './harness.js';

/** A write PostgreSQL refused outright, rather than silently matching no rows. */
export class Denied extends Error {
  constructor(cause: unknown) {
    super('Denied', { cause });
  }
}
export type InsertOutcome = 'allowed' | 'denied';
/** Every fixture table has an `id`; assertions name exactly which rows a principal reached. */
const IdentifiedRowsSchema = z.array(z.looseObject({ id: z.union([z.string(), z.number()]) }));
export type IdentifiedRows = z.output<typeof IdentifiedRowsSchema>;
export type Values = Readonly<Record<string, string | number | null>>;
const rows = (result: object[]): IdentifiedRows => IdentifiedRowsSchema.parse(result);

/** Policy violations and the immutable-column trigger both raise insufficient_privilege. */
function isInsufficientPrivilege(cause: unknown): boolean {
  const database = cause instanceof Error ? cause.cause : undefined;
  return database instanceof Error && 'code' in database && database.code === '42501';
}
async function refusing<R>(run: () => Promise<R>): Promise<R> {
  try {
    return await run();
  } catch (cause) {
    if (isInsufficientPrivilege(cause)) throw new Denied(cause);
    throw cause;
  }
}
// SAFETY: Values are fixture rows for the given table; PostgreSQL validates them on write.
const insertable = (values: Values | Values[]) => values as never;

/** Ordinary Drizzle queries, run as a principal through the application connection. */
export async function read(h: Harness, who: Principal, table: AnyProtectedTable, where?: SQL): Promise<IdentifiedRows> {
  return rows(await h.secured.as(who).transaction(async tx => tx.select().from(table).where(where)));
}
export async function insert(
  h: Harness,
  who: Principal,
  table: AnyProtectedTable,
  values: Values | Values[]
): Promise<InsertOutcome> {
  try {
    await h.secured.as(who).transaction(async tx => tx.insert(table).values(insertable(values)));
    return 'allowed';
  } catch (cause) {
    if (isInsufficientPrivilege(cause)) return 'denied';
    throw cause;
  }
}
export function update(
  h: Harness,
  who: Principal,
  table: AnyProtectedTable,
  values: Values,
  where: SQL
): Promise<IdentifiedRows> {
  return refusing(async () =>
    rows(await h.secured.as(who).transaction(async tx => tx.update(table).set(values).where(where).returning()))
  );
}
export function remove(h: Harness, who: Principal, table: AnyProtectedTable, where: SQL): Promise<IdentifiedRows> {
  return refusing(async () =>
    rows(await h.secured.as(who).transaction(async (tx: Database) => tx.delete(table).where(where).returning()))
  );
}

/** Sorted row IDs, so assertions state exactly which rows a principal reached. */
export function ids(result: IdentifiedRows): (string | number)[] {
  return result.map(row => row.id).sort();
}
/** Row IDs as the owner sees them, bypassing all enforcement: the ground truth after a write. */
export async function stored(h: Harness, table: AnyProtectedTable): Promise<(string | number)[]> {
  const id = getColumns(table)['id'];
  if (!id) throw new TypeError('Fixture tables have an id column');
  return ids(rows(await h.raw.select({ id }).from(table)));
}
/** The rows a write affected, treating an outright refusal as affecting none. */
export async function attempt<R>(write: Promise<R[]>): Promise<R[]> {
  try {
    return await write;
  } catch (error) {
    if (error instanceof Denied) return [];
    throw error;
  }
}
