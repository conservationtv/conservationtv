import { sql, type SQL } from 'drizzle-orm';
import { getTableConfig, PgDialect, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { roleAssignments } from './assignments.js';
import { accessPlan, filterSQL, type AccessCheck, type Subject } from './authorization.js';
import { AccessSchema, type Metadata, type Operation, type TableSchema } from './definitions.js';
import { columnType } from './values.js';

export const principalKindSetting = 'authz.principal_kind';
export const principalIdSetting = 'authz.principal_id';

/** Policies read the principal from transaction-local settings. Unset or cleared settings match no grant. */
const sessionSubject: Subject = {
  kind: sql`current_setting(${principalKindSetting}, true)`,
  id: sql`current_setting(${principalIdSetting}, true)`,
  now: sql`statement_timestamp()`
};
const operations: readonly Operation[] = ['select', 'insert', 'update', 'delete'];
const immutableTrigger = 'authz_immutable';
const dialect = new PgDialect();
// Definer functions read assignments and ancestor scope rows without the caller's own policies applying.
const definer = sql`stable security definer set search_path = pg_catalog, public, pg_temp`;
const quote = sql.raw('$authz$');

function render(statement: SQL): string {
  const query = dialect.sqlToQuery(statement.inlineParams());
  if (query.params.length) throw new TypeError('RLS migrations cannot contain bound parameters');
  return query.sql;
}
function functionName(meta: Metadata, ...parts: string[]): SQL {
  const name = ['authz', meta.name, ...parts].join(':');
  if (new TextEncoder().encode(name).length > 63) throw new TypeError(`RLS function name is too long: ${name}`);
  return sql`${sql.identifier(name)}`;
}
function keysFunction(meta: Metadata, operation: Operation, check: AccessCheck, index: number): SQL {
  return sql`create function ${functionName(meta, operation, String(index))}()
    returns setof ${sql.raw(columnType(check.key))} language sql ${definer} as ${quote} ${check.keys} ${quote}`;
}
function policy(meta: Metadata, operation: Operation, predicate: SQL): SQL {
  const name = sql.identifier(`authz_${operation}`);
  if (operation === 'insert') return sql`create policy ${name} on ${meta.table} for insert with check (${predicate})`;
  if (operation === 'update')
    return sql`create policy ${name} on ${meta.table} for update using (${predicate}) with check (${predicate})`;
  return sql`create policy ${name} on ${meta.table} for ${sql.raw(operation)} using (${predicate})`;
}
/** Each operation calls definer functions; the policy compares this table's columns with their key sets. */
function operationStatements(schema: AccessSchema, meta: Metadata, operation: Operation): SQL[] {
  // Without an action the operation has no policy, which RLS denies.
  if (!meta.operationActions.has(operation)) return [];
  const statements: SQL[] = [];
  const plan = accessPlan(schema.operation(meta.table, operation), sessionSubject);
  const global = functionName(meta, operation, 'global');
  if (plan.global)
    statements.push(sql`create function ${global}() returns boolean language sql ${definer}
      as ${quote} select ${plan.global} ${quote}`);
  statements.push(...plan.checks.map((check, index) => keysFunction(meta, operation, check, index)));
  const checks = plan.checks.map((check, index) => ({
    ...check,
    keys: sql`select ${functionName(meta, operation, String(index))}()`
  }));
  // Policy expressions see only this table, so its columns are referenced unqualified.
  const predicate = filterSQL(
    // A scalar subquery runs the global check once per statement; a bare call would run once per row.
    { global: plan.global && sql`(select ${global}())`, checks },
    column => sql`${sql.identifier(column.name)}`
  );
  statements.push(policy(meta, operation, predicate));
  return statements;
}
/** Protected sessions cannot move rows between scopes; trusted code without a principal still can. */
function immutableStatements(meta: Metadata): SQL[] {
  const columns = [...meta.immutable].map(key => sql.identifier(meta.columns[key]!.name));
  if (!columns.length) return [];
  const name = functionName(meta, 'immutable');
  const changed = sql.join(
    columns.map(column => sql`new.${column} is distinct from old.${column}`),
    sql` or `
  );
  return [
    sql`create function ${name}() returns trigger language plpgsql as ${quote}
    begin
      if coalesce(current_setting(${principalKindSetting}, true), '') <> '' and (${changed}) then
        raise exception 'Immutable access column on %', tg_table_name using errcode = '42501';
      end if;
      return new;
    end ${quote}`,
    sql`create trigger ${sql.identifier(immutableTrigger)} before update on ${meta.table} for each row execute function ${name}()`
  ];
}

/** Columns the database fills in itself, which no statement may write. */
function generated(column: AnyPgColumn): boolean {
  return column.generated !== undefined || column.generatedIdentity?.type === 'always';
}
function primaryKey(meta: Metadata, column: AnyPgColumn): boolean {
  return column.primary || getTableConfig(meta.table).primaryKeys.some(key => key.columns.includes(column));
}
function columnList(meta: Metadata, keep: (key: string, column: AnyPgColumn) => boolean): SQL[] {
  return Object.entries(meta.columns)
    .filter(([key, column]) => keep(key, column))
    .map(([, column]) => sql`${sql.identifier(column.name)}`);
}
/**
 * The application role's privileges on one table, derived from its definition: every operation an action declares,
 * unless the action is trusted. `select` covers every column but the hidden ones; `insert` and `delete` the whole table
 * (Drizzle names every column in an insert, sending `default` for those left out); `update` every column that a
 * protected update may change, which excludes the primary key, generated columns and immutable ones, scope links
 * included. Row-level security then chooses the rows.
 */
function privilegeStatements(meta: Metadata, role: string): SQL[] {
  const grantee = sql.identifier(role);
  const granted = new Set(
    [...meta.operationActions].filter(([, action]) => !meta.trusted.has(action)).map(([operation]) => operation)
  );
  // Revoking the table's privileges revokes its column privileges too, so each migration grants from nothing.
  const statements = [sql`revoke all on ${meta.table} from ${grantee}`];
  if (granted.has('select')) {
    const visible = columnList(meta, key => !meta.hidden.has(key));
    statements.push(
      meta.hidden.size
        ? sql`grant select (${sql.join(visible, sql`, `)}) on ${meta.table} to ${grantee}`
        : sql`grant select on ${meta.table} to ${grantee}`
    );
  }
  const whole = (['insert', 'delete'] as const).filter(operation => granted.has(operation));
  if (whole.length) statements.push(sql`grant ${sql.raw(whole.join(', '))} on ${meta.table} to ${grantee}`);
  if (granted.has('update')) {
    const changeable = columnList(
      meta,
      (key, column) => !meta.immutable.has(key) && !generated(column) && !primaryKey(meta, column)
    );
    if (changeable.length)
      statements.push(sql`grant update (${sql.join(changeable, sql`, `)}) on ${meta.table} to ${grantee}`);
  }
  return statements;
}

/** Marks files this package generated, so tooling can find the latest one among other migrations. */
export const migrationHeader = '-- Generated by @conservationtv/umbrella';
const teardownHeader = `${migrationHeader}: drop access policies.`;
// Drizzle's migrator splits files on this marker; some drivers accept only one statement per call.
const breakpoint = '\n--> statement-breakpoint\n';
/**
 * Drops every policy, immutability trigger and definer function an earlier migration generated, wherever it is,
 * so each migration rebuilds from nothing rather than leaving behind definitions that no longer exist.
 * Tables keep RLS enabled, so until policies are recreated the application role can reach no rows.
 */
const teardown = `do $authz$
declare item record;
begin
  for item in select schemaname, tablename, policyname from pg_catalog.pg_policies
      where policyname like 'authz\\_%' loop
    execute format('drop policy %I on %I.%I', item.policyname, item.schemaname, item.tablename);
  end loop;
  for item in select t.tgrelid::regclass as tbl from pg_catalog.pg_trigger t
      where t.tgname = '${immutableTrigger}' and not t.tgisinternal loop
    execute format('drop trigger ${immutableTrigger} on %s', item.tbl);
  end loop;
  for item in select p.oid::regprocedure as fn from pg_catalog.pg_proc p where p.proname like 'authz:%' loop
    execute format('drop function %s', item.fn);
  end loop;
end $authz$`;
function migration(header: string, statements: readonly string[]): string {
  return `${header}\n${statements.map(statement => `${statement};`).join(breakpoint)}\n`;
}

export interface RlsMigrationOptions {
  /**
   * The application role protected sessions log in as. When given, the migration also replaces its privileges on
   * every protected table with those the definitions imply (see `hidden` and `trusted`), so no hand-written grants
   * are needed for them. Tables without an access definition, and the assignments table, are left as they are.
   */
  readonly applicationRole?: string | undefined;
}

/**
 * PostgreSQL row-level security compiled from the same table definitions. Apply the result as the tables'
 * owner after the authorization migration, and run protected work through `session.transaction()` as a role
 * that does not own the tables. Assignments become readable only by their owner and the generated definer
 * functions. Each result first removes everything an earlier result created, so applying a sequence of them
 * leaves exactly the latest definitions.
 */
export function rlsMigration(tables: TableSchema, options: RlsMigrationOptions = {}): string {
  const schema = new AccessSchema(tables);
  const statements = [sql`alter table ${roleAssignments} enable row level security`];
  for (const meta of schema.entries())
    statements.push(
      sql`alter table ${meta.table} enable row level security`,
      ...operations.flatMap(operation => operationStatements(schema, meta, operation)),
      ...immutableStatements(meta),
      ...(options.applicationRole === undefined ? [] : privilegeStatements(meta, options.applicationRole))
    );
  return migration(`${migrationHeader}.`, [teardown, ...statements.map(render)]);
}

/**
 * Removes the generated policies, leaving protected tables closed. Apply it before a schema change that alters
 * or drops a scope key or link, which PostgreSQL refuses while a policy uses the column; the `rlsMigration`
 * applied afterwards restores access.
 */
export function rlsTeardownMigration(): string {
  return migration(teardownHeader, [teardown]);
}
