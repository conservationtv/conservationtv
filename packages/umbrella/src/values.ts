import { SQL, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { z } from 'zod';

export const ScopeIdSchema = z.union([
  z.string().min(1),
  z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER)
]);
export type ScopeId = z.output<typeof ScopeIdSchema>;
export const AccessNameSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]*$/);
export type AccessName = z.output<typeof AccessNameSchema>;

// PostgreSQL values include JSON, binary data, dates and bigint, including typed arrays.
export const ColumnValueSchema = z.union([
  z.union([z.number(), z.nan(), z.literal(Infinity), z.literal(-Infinity)]),
  z.bigint(),
  z.date(),
  z.instanceof(Uint8Array),
  z.array(z.date()),
  z.array(z.bigint()),
  z.json()
]);
export type ColumnValue = z.output<typeof ColumnValueSchema>;
export const DriverRowSchema = z.record(z.string(), ColumnValueSchema);
export type DriverRow = z.output<typeof DriverRowSchema>;
export const DriverRowsSchema = z.array(DriverRowSchema);
export type DriverRows = z.output<typeof DriverRowsSchema>;
export const DriverResultSchema = z.union([DriverRowsSchema, z.object({ rows: DriverRowsSchema })]);
export type DriverResult = z.output<typeof DriverResultSchema>;

/** Decode values where driver or application data enters the protected client. */
export function decode<S extends z.ZodType, Input>(schema: S, input: Input): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new TypeError(result.error.message);
  return result.data;
}

export function authorizationTime(now = new Date()): Date {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError('Invalid authorization clock');
  return new Date(now);
}

/** The column's SQL type, usable in casts; serial pseudo-types become their storage types. */
export function columnType(column: AnyPgColumn): string {
  return column
    .getSQLType()
    .replace(/^serial$/, 'integer')
    .replace(/^bigserial$/, 'bigint')
    .replace(/^smallserial$/, 'smallint');
}
/** A parameter cast to the column's type, so PostgreSQL compares and canonicalizes it as that type. */
export function typedParam(column: AnyPgColumn, value: ColumnValue): SQL {
  return sql`${sql.param(value, column)}::${sql.raw(columnType(column))}`;
}
