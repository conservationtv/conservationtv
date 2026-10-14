import { and, eq, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { roleAssignments } from './assignments.js';
import {
  Scope,
  root,
  principal,
  parentBinding,
  scopeNames,
  type AccessSchema,
  type AnyScope,
  type Metadata,
  type OperationAccess,
  type PermissionContribution,
  type Principal,
  type ResourceScope,
  type ScopeRef
} from './definitions.js';
import { columnType, typedParam } from './values.js';

export type ColumnSQL = (column: AnyPgColumn) => SQL;

/** Who is asking and when; policies read these from transaction-local session settings. */
export interface Subject {
  readonly kind: SQL;
  readonly id: SQL;
  readonly now: SQL;
}
export function activeSQL(now: SQL): SQL<boolean> {
  return sql`((${roleAssignments.startsAt} is null or ${roleAssignments.startsAt} <= ${now}) and
    (${roleAssignments.expiresAt} is null or ${roleAssignments.expiresAt} > ${now}))`;
}
export function principalSQL(subject: Principal | undefined): SQL | undefined {
  if (!subject) return undefined;
  const valid = principal(subject.kind, subject.id);
  return and(eq(roleAssignments.principalKind, valid.kind), eq(roleAssignments.principalId, String(valid.id)));
}
/** Inspection matches the same grant identity and assignable scope level as enforcement. */
export function grantSQL(
  resource: string | SQLWrapper,
  role: string | SQLWrapper,
  scopeName: string | SQLWrapper
): SQL {
  return sql`(${roleAssignments.resource} = ${resource} and ${roleAssignments.role} = ${role} and ${roleAssignments.scopeName} = ${scopeName})`;
}

/** One authorization predicate: the row is allowed if a global grant applies or any column holds a reachable key. */
export interface AccessPlan {
  readonly global: SQL | undefined;
  readonly checks: readonly AccessCheck[];
}
/** `column = any(array(keys))`: keys is an uncorrelated query PostgreSQL evaluates once per statement. */
export interface AccessCheck {
  readonly column: AnyPgColumn;
  /** The scope key whose values the query yields. */
  readonly key: AnyPgColumn;
  readonly keys: SQL;
}
interface PlanContext {
  readonly subject: Subject;
  readonly grants: ReadonlyMap<string, readonly PermissionContribution[]>;
}

/** Roles that grant the operation's permission, grouped by the scope level they are assigned at. */
function grantsByScope(access: OperationAccess): Map<string, PermissionContribution[]> {
  const grants = new Map<string, PermissionContribution[]>();
  for (const row of access.contributions) {
    if (row.permission !== access.permission) continue;
    const rows = grants.get(row.scopeName) ?? [];
    rows.push(row);
    grants.set(row.scopeName, rows);
  }
  return grants;
}
function assignedAt(context: PlanContext, scopeName: string, roles: readonly PermissionContribution[]): SQL {
  const { subject } = context;
  const names = roles.map(role => sql`(${role.grantResource}, ${role.grantRole})`);
  return sql`${roleAssignments.principalKind} = ${subject.kind} and ${roleAssignments.principalId} = ${subject.id}
    and ${activeSQL(subject.now)} and ${roleAssignments.scopeName} = ${scopeName}
    and (${roleAssignments.resource}, ${roleAssignments.role}) in (${sql.join(names, sql`, `)})`;
}
function globalSQL(context: PlanContext): SQL | undefined {
  const roles = context.grants.get(root.name);
  return roles && sql`exists (select 1 from ${roleAssignments} where ${assignedAt(context, root.name, roles)})`;
}
/** Keys granted directly at this scope level. CASE keeps the cast away from other levels' IDs. */
function directKeys(context: PlanContext, scope: AnyScope): SQL | undefined {
  const roles = context.grants.get(scope.name);
  if (!roles) return undefined;
  const key = sql`case when ${roleAssignments.scopeName} = ${scope.name}
    then ${roleAssignments.scopeId}::${sql.raw(columnType(scope.key))} end`;
  return sql`select ${key} from ${roleAssignments} where ${assignedAt(context, scope.name, roles)}`;
}
/** Keys of every scope row the subject reaches directly or through an ancestor, resolved from the top down. */
function reachableKeys(context: PlanContext, scope: AnyScope, depth: number): SQL | undefined {
  const parts: SQL[] = [];
  const direct = directKeys(context, scope);
  if (direct) parts.push(direct);
  const parent = parentBinding(scope);
  const parentKeys = parent && reachableKeys(context, parent.scope, depth + 1);
  if (parent && parentKeys) {
    const alias = sql.identifier(`__authz_scope_${depth}`);
    parts.push(sql`select ${alias}.${sql.identifier(scope.key.name)} from ${scope.key.table} as ${alias}
      where ${alias}.${sql.identifier(parent.column.name)} in (${parentKeys})`);
  }
  return parts.length ? sql.join(parts, sql` union all `) : undefined;
}
/** A scope-defining row matches its own grants by key, and inherited grants by its parent link. */
function ownScopeChecks(context: PlanContext, scope: AnyScope, insert: boolean): AccessCheck[] {
  const checks: AccessCheck[] = [];
  // A row being inserted cannot hold grants yet, even if stale grants name its future key.
  const own = insert ? undefined : directKeys(context, scope);
  if (own) checks.push({ column: scope.key, key: scope.key, keys: own });
  const parent = parentBinding(scope);
  const inherited = parent && reachableKeys(context, parent.scope, 0);
  if (parent && inherited) checks.push({ column: parent.column, key: parent.scope.key, keys: inherited });
  return checks;
}
function bindingChecks(context: PlanContext, binding: ResourceScope, insert: boolean): AccessCheck[] {
  if (binding instanceof Scope) return ownScopeChecks(context, binding, insert);
  if (!('column' in binding)) return [];
  const keys = reachableKeys(context, binding.scope, 0);
  return keys ? [{ column: binding.column, key: binding.scope.key, keys }] : [];
}
export function accessPlan(access: OperationAccess, subject: Subject): AccessPlan {
  const context: PlanContext = { subject, grants: grantsByScope(access) };
  const insert = access.operation === 'insert';
  return {
    global: globalSQL(context),
    checks: Object.values(access.metadata.scopes).flatMap(binding => bindingChecks(context, binding, insert))
  };
}
/**
 * Keys are materialized into an array before the scan, so the planner can use an index on the binding column
 * whatever it estimates the key set's size to be, including when the keys come from an opaque policy function.
 */
export function filterSQL(plan: AccessPlan, column: ColumnSQL): SQL {
  const parts = plan.checks.map(check => sql`${column(check.column)} = any(array(${check.keys}))`);
  if (plan.global) parts.unshift(plan.global);
  return parts.length ? sql`(${sql.join(parts, sql` or `)})` : sql`false`;
}
/** The stored form of a scope ID: PostgreSQL's text rendering of the key's type, such as a lowercase UUID. */
export function scopeIdSQL(schema: AccessSchema, ref: ScopeRef): SQL {
  const scope = schema.scope(ref);
  if (scope.id === null) return sql`''`;
  return sql`(${typedParam(schema.scopes.get(scope.name)!.key, scope.id)})::text`;
}
const rootMatch = sql`(${roleAssignments.scopeName} = ${root.name} and ${roleAssignments.scopeId} = '')`;
/** Grants at one known scope row or any of its ancestors, following actual parent links upward. */
function ancestorSQL(scope: AnyScope, id: SQL, depth: number): SQL {
  const own = sql`(${roleAssignments.scopeName} = ${scope.name} and ${roleAssignments.scopeId} = (${id})::text)`;
  const parent = parentBinding(scope);
  if (!parent) return own;
  const alias = sql.identifier(`__authz_scope_${depth}`);
  const parentId = sql`${alias}.${sql.identifier(parent.column.name)}`;
  return sql`(${own} or exists (select 1 from ${scope.key.table} as ${alias}
    where ${alias}.${sql.identifier(scope.key.name)} = ${id} and ${ancestorSQL(parent.scope, parentId, depth + 1)}))`;
}
/** Assignments that apply at a reporting context; a missing scope row has no inherited grants. */
export function contextSQL(schema: AccessSchema, meta: Metadata, ref: ScopeRef): SQL {
  const scope = schema.scope(ref);
  if (!Object.values(meta.scopes).flatMap(scopeNames).includes(scope.name))
    throw new TypeError('Scope is not bound to this resource');
  if (scope.id === null) return rootMatch;
  const node = schema.scopes.get(scope.name)!;
  const id = typedParam(node.key, scope.id);
  return sql`(exists (select 1 from ${node.key.table} where ${node.key} = ${id})
    and (${rootMatch} or ${ancestorSQL(node, id, 0)}))`;
}
