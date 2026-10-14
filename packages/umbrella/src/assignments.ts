import { index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

/** Reuse the assignment layout for typed query results without copying its columns. */
export function assignmentColumns() {
  return {
    id: uuid().primaryKey().defaultRandom(),
    principalKind: text('principal_kind').notNull(),
    principalId: text('principal_id').notNull(),
    resource: text().notNull(),
    role: text().notNull(),
    scopeName: text('scope_name').notNull(),
    scopeId: text('scope_id').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true })
  };
}

/** Include this table in your normal Drizzle migration schema. */
export const roleAssignments = pgTable('authz_role_assignments', assignmentColumns(), table => [
  unique('authz_unique_grant')
    .on(
      table.principalKind,
      table.principalId,
      table.resource,
      table.role,
      table.scopeName,
      table.scopeId,
      table.startsAt,
      table.expiresAt
    )
    .nullsNotDistinct(),
  index('authz_principal_lookup').on(table.principalKind, table.principalId, table.resource, table.role),
  index('authz_scope_lookup').on(table.scopeName, table.scopeId)
]);

export type Assignment = typeof roleAssignments.$inferSelect;
