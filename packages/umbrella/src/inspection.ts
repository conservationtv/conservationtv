import { and, eq, getColumns, getTableName, not, sql, Subquery, type InferSelectModel, type SQL } from 'drizzle-orm';
import { boolean, pgTable, text, type PgTable } from 'drizzle-orm/pg-core';
import { assignmentColumns, roleAssignments } from './assignments.js';
import { activeSQL, contextSQL, grantSQL, principalSQL, scopeIdSQL } from './authorization.js';
import {
  principal,
  scopeNames,
  sharedResource,
  type AccessSchema,
  type AnyProtectedTable,
  type Metadata,
  type Operation,
  type Principal,
  type RoleRef,
  type ScopeRef
} from './definitions.js';
import type { Database } from './client.js';
import { authorizationTime } from './values.js';

export type RoleKind = 'shared' | 'table';
export type GrantStatus = 'active' | 'pending' | 'expired';
export interface RoleMember {
  roleId: string;
  resource: string;
  role: string;
  permissions: string[];
}
export interface CatalogRole {
  id: string;
  resource: string;
  name: string;
  roleKind: RoleKind;
  label: string;
  description: string | null;
  permissions: string[];
  assignableScopes: string[];
  includedIn: string[];
  includes: RoleMember[];
}
export interface CatalogAction {
  name: string;
  operations: readonly Operation[];
}
export interface CatalogResource {
  name: string;
  scopes: readonly string[];
  actions: readonly CatalogAction[];
  roles: readonly CatalogRole[];
}
export interface AccessCatalog {
  sharedRoles: readonly CatalogRole[];
  resources: readonly CatalogResource[];
}
export interface GrantedBy {
  assignmentId: string;
  roleId: string;
  role: string;
  roleKind: RoleKind;
  label: string;
  description: string | null;
  through: string;
  scope: ScopeRef;
}
export interface AssignedRole extends Omit<GrantedBy, 'through'> {
  resource: string;
  startsAt: Date | null;
  expiresAt: Date | null;
  status: GrantStatus;
  active: boolean;
  inherited: boolean;
}
export type AssignedRoles = AssignedRole[];
export interface PermissionDecision {
  allowed: boolean;
  grantedBy: GrantedBy[];
}
export type PermissionMap = Record<string, PermissionDecision>;
export interface GrantQueryOptions {
  principal?: Principal;
  role?: RoleRef;
  resource?: AnyProtectedTable;
  scope?: ScopeRef;
  active?: boolean;
  now?: Date;
}
export interface InspectQueryOptions<T extends AnyProtectedTable = AnyProtectedTable> {
  resource: T;
  scope: ScopeRef;
  principal?: Principal;
  now?: Date;
}
export interface InspectOptions<T extends AnyProtectedTable = AnyProtectedTable> extends InspectQueryOptions<T> {
  principal: Principal;
}

// These are query result layouts, never persistent migration tables.
const catalogColumns = pgTable('__authz_catalog', {
  id: text().notNull(),
  resource: text().notNull(),
  name: text().notNull(),
  roleKind: text('roleKind').$type<RoleKind>().notNull(),
  label: text().notNull(),
  description: text(),
  permissions: text().array().notNull(),
  assignableScopes: text('assignableScopes').array().notNull(),
  includedIn: text('includedIn').array().notNull()
});
const grantColumns = pgTable('__authz_grants', {
  ...assignmentColumns(),
  roleId: text('role_id').notNull(),
  roleKind: text('role_kind').$type<RoleKind>().notNull(),
  label: text().notNull(),
  description: text(),
  known: boolean().notNull(),
  active: boolean().notNull(),
  status: text().$type<GrantStatus>().notNull()
});
const effectColumns = pgTable('__authz_effects', {
  ...assignmentColumns(),
  targetResource: text('target_resource').notNull(),
  tableRole: text('table_role').notNull(),
  permission: text().notNull(),
  inherited: boolean().notNull(),
  active: boolean().notNull(),
  status: text().$type<GrantStatus>().notNull()
});
const summaryColumns = pgTable('__authz_access', {
  principalKind: text('principal_kind').notNull(),
  principalId: text('principal_id').notNull(),
  roles: text().array().notNull(),
  permissions: text().array().notNull()
});
export type PermissionEffect = InferSelectModel<typeof effectColumns>;
function relation<T extends PgTable>(table: T, query: SQL) {
  const fields = getColumns(table);
  return new Subquery<T['_']['name'], typeof fields>(query, fields, getTableName(table));
}
const roleId = (resource: string, name: string): string => `${resource}/${name}`;
const kind = (resource: string): RoleKind => (resource === sharedResource ? 'shared' : 'table');
function statusSQL(now: SQL): SQL<GrantStatus> {
  return sql`case when ${roleAssignments.startsAt} > ${now} then 'pending'
    when ${roleAssignments.expiresAt} <= ${now} then 'expired' else 'active' end`;
}
function tableRoles(schema: AccessSchema, meta: Metadata): CatalogRole[] {
  const contributions = schema.contributions(meta.table);
  return Object.entries(meta.roles).map(([name, definition]) => {
    const rows = contributions.filter(row => row.tableRole === name);
    return {
      id: roleId(meta.name, name),
      resource: meta.name,
      name,
      roleKind: 'table',
      label: definition.label,
      description: definition.description,
      permissions: [...new Set(rows.map(row => row.permission))],
      assignableScopes: [...definition.assignableScopes],
      includedIn: [
        ...new Set(
          rows.filter(row => row.grantResource === sharedResource).map(row => roleId(row.grantResource, row.grantRole))
        )
      ],
      includes: []
    };
  });
}
export function buildCatalog(schema: AccessSchema): AccessCatalog {
  const resources = schema.entries().map(meta => ({
    name: meta.name,
    scopes: [...new Set(Object.values(meta.scopes).flatMap(scopeNames))],
    actions: Object.entries(meta.actions).map(([name, operations]) => ({ name, operations: [...operations] })),
    roles: tableRoles(schema, meta)
  }));
  const local = resources.flatMap(resource => resource.roles);
  const sharedRoles: CatalogRole[] = schema.sharedEntries().map(role => {
    const id = roleId(role.resource, role.name);
    return {
      id,
      resource: role.resource,
      name: role.name,
      roleKind: 'shared',
      label: role.label,
      description: role.description,
      permissions: [],
      assignableScopes: [...role.scopes],
      includedIn: [],
      includes: local
        .filter(role => role.includedIn.includes(id))
        .map(role => ({
          roleId: role.id,
          resource: role.resource,
          role: role.name,
          permissions: [...role.permissions]
        }))
    };
  });
  return { sharedRoles, resources };
}
function grantFilters(schema: AccessSchema, options: GrantQueryOptions, now: SQL): SQL | undefined {
  // These filters describe exact stored assignments and time windows, including orphaned roles for auditing.
  const filters: (SQL | undefined)[] = [principalSQL(options.principal)];
  if (options.role) {
    const role = schema.role(options.role);
    filters.push(eq(roleAssignments.resource, role.resource), eq(roleAssignments.role, role.name));
  }
  if (options.resource) filters.push(eq(roleAssignments.resource, schema.table(options.resource).name));
  if (options.scope) {
    filters.push(
      eq(roleAssignments.scopeName, schema.scope(options.scope).name),
      eq(roleAssignments.scopeId, scopeIdSQL(schema, options.scope))
    );
  }
  if (options.active !== undefined) filters.push(options.active ? activeSQL(now) : not(activeSQL(now)));
  return and(...filters);
}
/** All reporting reads this flat contribution query; rich JSON belongs to the application formatter. */
function effectsSQL(schema: AccessSchema, options: InspectQueryOptions, now: SQL): SQL {
  const meta = schema.table(options.resource);
  const contributions = JSON.stringify(schema.contributions(options.resource));
  const local = sql`${roleAssignments.scopeName} = ${options.scope.name} and ${roleAssignments.scopeId} = ${scopeIdSQL(schema, options.scope)}`;
  return sql`select ${roleAssignments}.*, c.resource as target_resource, c."tableRole" as table_role, c.permission,
    not (${local}) as inherited, ${activeSQL(now)} as active, ${statusSQL(now)} as status
    from ${roleAssignments} join jsonb_to_recordset(${contributions}::jsonb) as c(
      "grantResource" text, "grantRole" text, resource text, "tableRole" text, "scopeName" text, permission text)
    on ${grantSQL(sql`c."grantResource"`, sql`c."grantRole"`, sql`c."scopeName"`)}
    where ${and(contextSQL(schema, meta, options.scope), principalSQL(options.principal))}`;
}
function roleDisplay(schema: AccessSchema, row: PermissionEffect): Omit<GrantedBy, 'through'> {
  // Resolve display metadata from the registry, with stored names as fallbacks; the empty scope ID represents root.
  const role = schema.lookupRole(row.resource, row.role);
  return {
    assignmentId: row.id,
    roleId: roleId(row.resource, row.role),
    role: row.role,
    roleKind: kind(row.resource),
    label: role?.label ?? row.role,
    description: role?.description ?? null,
    scope: { name: row.scopeName, id: row.scopeId === '' ? null : row.scopeId }
  };
}
function assignmentDisplay(schema: AccessSchema, row: PermissionEffect): AssignedRole {
  return {
    ...roleDisplay(schema, row),
    resource: row.resource,
    startsAt: row.startsAt,
    expiresAt: row.expiresAt,
    status: row.status,
    active: row.active,
    inherited: row.inherited
  };
}
function explain(schema: AccessSchema, meta: Metadata, rows: readonly PermissionEffect[]) {
  const roles = new Map<string, AssignedRole>();
  const permissions: PermissionMap = Object.fromEntries(
    Object.keys(meta.actions).map(action => [action, { allowed: false, grantedBy: [] }])
  );
  for (const row of rows) {
    roles.set(row.id, assignmentDisplay(schema, row));
    if (!row.active) continue;
    const decision = permissions[row.permission]!;
    decision.allowed = true;
    decision.grantedBy.push({ ...roleDisplay(schema, row), through: `${row.targetResource}.${row.tableRole}` });
  }
  return { roles: [...roles.values()], permissions };
}

/** Reports evaluate time windows at a fixed instant, captured when the query is built. */
function reportTime(clock: () => Date, now: Date | undefined): SQL {
  return sql`${sql.param(authorizationTime(now ?? clock()), roleAssignments.startsAt)}`;
}
/** Bound database functions share one registry and a single flat matching query. */
export function createAccessQueries(db: Database, schema: AccessSchema, clock: () => Date) {
  const definitions = buildCatalog(schema);
  const catalogRows = JSON.stringify([
    ...definitions.sharedRoles,
    ...definitions.resources.flatMap(resource => resource.roles)
  ]);
  const catalogRelation = () =>
    relation(
      catalogColumns,
      sql`select * from jsonb_to_recordset(${catalogRows}::jsonb) as c(id text, resource text, name text, "roleKind" text,
        label text, description text, permissions text[], "assignableScopes" text[], "includedIn" text[])`
    );
  const effectsQuery = <T extends AnyProtectedTable>(options: InspectQueryOptions<T>, now: SQL) =>
    db.select(getColumns(effectColumns)).from(relation(effectColumns, effectsSQL(schema, options, now)));

  function grantsQuery(options: GrantQueryOptions = {}) {
    const now = reportTime(clock, options.now);
    const catalog = db.select(getColumns(catalogColumns)).from(catalogRelation()).as('roles');
    const query = db
      .select({
        ...getColumns(roleAssignments),
        roleId: sql<string>`${roleAssignments.resource} || '/' || ${roleAssignments.role}`.as('role_id'),
        roleKind:
          sql<RoleKind>`case when ${roleAssignments.resource} = ${sharedResource} then 'shared' else 'table' end`.as(
            'role_kind'
          ),
        label: sql<string>`coalesce(${catalog.label}, ${roleAssignments.role})`.as('label'),
        description: catalog.description,
        known: sql<boolean>`${catalog.id} is not null`.as('known'),
        active: activeSQL(now).as('active'),
        status: statusSQL(now).as('status')
      })
      .from(roleAssignments)
      .leftJoin(catalog, and(eq(roleAssignments.resource, catalog.resource), eq(roleAssignments.role, catalog.name)))
      .where(grantFilters(schema, options, now));
    return db.select(getColumns(grantColumns)).from(relation(grantColumns, query.getSQL())).$dynamic();
  }
  function inspectQuery<T extends AnyProtectedTable>(options: InspectQueryOptions<T>) {
    const query = sql`select principal_kind, principal_id,
      coalesce(array_agg(distinct resource || '/' || role order by resource || '/' || role) filter (where active), '{}'::text[]) as roles,
      coalesce(array_agg(distinct permission order by permission) filter (where active), '{}'::text[]) as permissions
      from (${effectsSQL(schema, options, reportTime(clock, options.now))}) as effects group by principal_kind, principal_id`;
    return db.select(getColumns(summaryColumns)).from(relation(summaryColumns, query)).$dynamic();
  }
  async function inspect<T extends AnyProtectedTable>(options: InspectOptions<T>) {
    const subject = principal(options.principal.kind, options.principal.id);
    const scope = schema.scope(options.scope);
    const evaluatedAt = authorizationTime(options.now ?? clock());
    const rows = await effectsQuery({ ...options, principal: subject, scope }, reportTime(clock, evaluatedAt));
    const meta = schema.table(options.resource);
    return { principal: subject, resource: meta.name, scope, evaluatedAt, ...explain(schema, meta, rows) };
  }
  return {
    catalog: (): AccessCatalog => structuredClone(definitions),
    grantsQuery,
    inspectQuery,
    inspect
  };
}
