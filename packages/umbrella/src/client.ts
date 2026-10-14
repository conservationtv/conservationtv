import { and, eq, is, or, sql } from 'drizzle-orm';
import { PgTransaction, type PgDatabase, type PgTransactionConfig } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { roleAssignments, type Assignment } from './assignments.js';
import { scopeIdSQL } from './authorization.js';
import { buildCatalog, createAccessQueries, type AccessCatalog } from './inspection.js';
import { principalIdSetting, principalKindSetting } from './rls.js';
import {
  AccessSchema,
  AuthorizationError,
  parentBinding,
  principal,
  root,
  type Principal,
  type RootScope,
  type TableSchema,
  type SharedRoleRegistry,
  type RoleRef,
  type ScopeRef
} from './definitions.js';
import { DriverResultSchema, authorizationTime, decode, type DriverResult } from './values.js';

// Drizzle's driver HKT owns the result contract for each supported database driver.
export type Database = PgDatabase<any, any, any>;

/**
 * Whether the connection can skip row-level security: a superuser or BYPASSRLS role, or a member of a protected
 * table's owner. Any of these would let a session see every row, or regain those privileges with SET ROLE.
 */
const bypassSQL = sql`(exists (select 1 from pg_roles r
    where (r.rolsuper or r.rolbypassrls) and pg_has_role(current_user, r.oid, 'MEMBER'))
  or exists (select 1 from pg_class c
    where c.relrowsecurity and not c.relforcerowsecurity and pg_has_role(current_user, c.relowner, 'MEMBER')))`;
const ConnectionCheckSchema = z.object({ bypasses: z.boolean() });
type ConnectionCheck = z.output<typeof ConnectionCheckSchema>;
/** Shared by one client's sessions: every pooled connection logs in with the same credentials. */
interface ConnectionState {
  verified: boolean;
}
function bypasses(result: DriverResult): boolean {
  const parsed = decode(DriverResultSchema, result);
  const [row] = Array.isArray(parsed) ? parsed : parsed.rows;
  const check: ConnectionCheck = decode(ConnectionCheckSchema, row);
  return check.bypasses;
}

interface SessionState {
  db: Database;
  subject: Principal;
  connection: ConnectionState;
}
// Keep the database handle outside the public Session object, including at runtime.
const sessions = new WeakMap<Session, SessionState>();
function state(session: Session): SessionState {
  const value = sessions.get(session);
  if (!value) throw new TypeError('Invalid authorization session');
  return value;
}
/** One principal's access to the application database, enforced by the policies `rlsMigration` installs. */
export class Session {
  constructor(db: Database, subject: Principal, connection: ConnectionState) {
    sessions.set(this, { db, subject: principal(subject.kind, subject.id), connection });
  }
  /**
   * Run any Drizzle query, including joins, relational queries and raw SQL, as this principal. The principal is
   * transaction-local: a top-level transaction discards it on commit or rollback, and inside a caller's
   * transaction it is cleared before the caller resumes. The first call also refuses a connection that could
   * bypass row-level security, in the same statement that sets the principal.
   */
  transaction<R>(run: (db: Database) => Promise<R>, config?: PgTransactionConfig): Promise<R> {
    const { db, subject, connection } = state(this);
    const nested = is(db, PgTransaction);
    const check = connection.verified ? sql`` : sql`, ${bypassSQL} as bypasses`;
    return db.transaction(async tx => {
      const setup = await tx.execute(sql`select set_config(${principalKindSetting}, ${subject.kind}, true),
        set_config(${principalIdSetting}, ${String(subject.id)}, true)${check}`);
      if (!connection.verified) {
        if (bypasses(setup))
          throw new AuthorizationError(
            'The application connection can bypass row-level security; connect as a role without superuser, BYPASSRLS or table ownership'
          );
        connection.verified = true;
      }
      const result = await run(tx);
      // Only a savepoint outlives this call, so only then is the principal cleared explicitly.
      if (nested)
        await tx.execute(
          sql`select set_config(${principalKindSetting}, '', true), set_config(${principalIdSetting}, '', true)`
        );
      return result;
    }, config);
  }
}

export interface GrantOptions<R extends RoleRef> {
  principal: Principal;
  role: R;
  startsAt?: Date;
  expiresAt?: Date;
}
type ScopedGrant<S extends ScopeRef, R extends RoleRef> = GrantOptions<R> & ScopedRole<S, R>;
type ScopedRole<S extends ScopeRef, R extends RoleRef> = {
  role: R & (S['name'] extends NoInfer<R>['assignableScopes'][number] ? unknown : never);
};
interface ListOptions {
  includeInherited?: boolean;
}
/** A scope as stored in assignments: the root's ID is empty, others are PostgreSQL's text rendering of the key. */
interface StoredScope {
  name: string;
  id: string;
}
interface ScopeRow {
  id: string;
  parentId: string | null;
}
function validDate(value: Date | undefined): Date | null {
  return value === undefined ? null : authorizationTime(value);
}
export class AccessAt<S extends ScopeRef> {
  constructor(
    private readonly db: Database,
    private readonly schema: AccessSchema,
    private readonly scope: S
  ) {}
  /** Existing scope rows from this scope upward, with IDs in their stored form. */
  private async path(inherited: boolean): Promise<StoredScope[]> {
    const path: StoredScope[] = [];
    let current: ScopeRef = this.scope;
    while (current.name !== root.name) {
      // Each step reads one scope row; a missing row fails rather than reporting a partial path.
      const node = this.schema.scopes.get(current.name)!;
      const parent = parentBinding(node);
      const [row]: ScopeRow[] = await this.db
        .select({
          id: sql<string>`${node.key}::text`,
          parentId: parent ? sql<string>`${parent.column}::text` : sql<null>`null`
        })
        .from(node.key.table)
        .where(eq(node.key, current.id))
        .limit(1);
      if (!row) throw new TypeError(`Scope does not exist: ${current.name}:${current.id}`);
      path.push({ name: node.name, id: row.id });
      if (!inherited) return path;
      current = parent && row.parentId !== null ? { name: parent.scope.name, id: row.parentId } : root;
    }
    path.push({ name: root.name, id: '' });
    return path;
  }
  async grant<R extends RoleRef>(options: ScopedGrant<S, R>): Promise<Assignment> {
    // Validate the scope and time window before inserting or reusing the identical grant.
    const role = this.schema.role(options.role);
    if (!role.scopes.includes(this.scope.name)) throw new TypeError('Role cannot be assigned at this scope');
    const subject = principal(options.principal.kind, options.principal.id);
    const startsAt = validDate(options.startsAt);
    const expiresAt = validDate(options.expiresAt);
    if (startsAt && expiresAt && startsAt >= expiresAt) throw new TypeError('Grant start must precede expiry');
    const [scope] = await this.path(false);
    const result = await this.db
      .insert(roleAssignments)
      .values({
        principalKind: subject.kind,
        principalId: String(subject.id),
        resource: role.resource,
        role: role.name,
        scopeName: scope!.name,
        scopeId: scope!.id,
        startsAt,
        expiresAt
      })
      .onConflictDoUpdate({
        target: [
          roleAssignments.principalKind,
          roleAssignments.principalId,
          roleAssignments.resource,
          roleAssignments.role,
          roleAssignments.scopeName,
          roleAssignments.scopeId,
          roleAssignments.startsAt,
          roleAssignments.expiresAt
        ],
        // Keep the stored ID and return it atomically, including for concurrent duplicate calls.
        set: { id: sql`${roleAssignments.id}` }
      })
      .returning();
    return result[0]!;
  }
  /** Removes matching grants even if the scope row was already deleted. */
  async revoke<R extends RoleRef>(options: Pick<GrantOptions<R>, 'principal' | 'role'>): Promise<number> {
    const role = this.schema.role(options.role);
    const subject = principal(options.principal.kind, options.principal.id);
    const result = await this.db
      .delete(roleAssignments)
      .where(
        and(
          eq(roleAssignments.scopeName, this.scope.name),
          eq(roleAssignments.scopeId, scopeIdSQL(this.schema, this.scope)),
          eq(roleAssignments.resource, role.resource),
          eq(roleAssignments.role, role.name),
          eq(roleAssignments.principalKind, subject.kind),
          eq(roleAssignments.principalId, String(subject.id))
        )
      )
      .returning({ id: roleAssignments.id });
    return result.length;
  }
  async list(options: ListOptions = {}): Promise<Assignment[]> {
    const path = await this.path(options.includeInherited ?? false);
    const scopes = path.map(scope =>
      and(eq(roleAssignments.scopeName, scope.name), eq(roleAssignments.scopeId, scope.id))
    );
    return this.db
      .select()
      .from(roleAssignments)
      .where(or(...scopes));
  }
}
/**
 * The two connections an authorization client needs. `app` must log in as a role that cannot bypass row-level
 * security; `admin` owns the tables and manages grants, inspection and migrations.
 */
export interface AuthorizationDatabases {
  app: Database;
  admin: Database;
}
export interface AuthorizationOptions {
  schema: TableSchema;
  roles?: SharedRoleRegistry;
  /** The clock for inspection reports; enforcement uses the database's statement time. */
  clock?: () => Date;
}

/** The privileged management API: grants, revocation, catalog and reports, bound to the owning connection. */
export type Access = ReturnType<typeof createAccess>;

function createAccess(admin: Database, schema: AccessSchema, clock: () => Date) {
  return {
    ...createAccessQueries(admin, schema, clock),
    root(): AccessAt<RootScope> {
      return new AccessAt(admin, schema, { ...root });
    },
    at<const S extends ScopeRef>(scope: S): AccessAt<S> {
      schema.scope(scope);
      return new AccessAt(admin, schema, { ...scope });
    },
    async revoke(id: string): Promise<boolean> {
      const result = await admin
        .delete(roleAssignments)
        .where(eq(roleAssignments.id, id))
        .returning({ id: roleAssignments.id });
      return result.length > 0;
    }
  };
}

/** The compiled access definitions, independent of any connection. */
export interface Authorization {
  /** Every role from the loaded definitions, without a database query. */
  catalog(): AccessCatalog;
  /**
   * A request session over an application connection: a role that cannot bypass row-level security. Each
   * connection is checked for that once, in the first transaction's own setup statement.
   */
  as(app: Database, subject: Principal): Session;
  /** The management API over the owning connection. Never hand it to request handlers. */
  access(admin: Database): Access;
}

/**
 * Compile the definitions once, typically at module scope; connect them per request. Most requests only need
 * `as()` and the application connection; `access()` is for trusted code with the owning connection.
 */
export function defineAuthorization(options: AuthorizationOptions): Authorization {
  const schema = new AccessSchema(options.schema, options.roles);
  const clock = options.clock ?? (() => new Date());
  const definitions = buildCatalog(schema);
  // One verification per connection object, shared by every session over it.
  const connections = new WeakMap<Database, ConnectionState>();
  const connection = (app: Database): ConnectionState => {
    let state = connections.get(app);
    if (!state) {
      state = { verified: false };
      connections.set(app, state);
    }
    return state;
  };
  return {
    catalog: () => structuredClone(definitions),
    as: (app, subject) => new Session(app, subject, connection(app)),
    access: admin => createAccess(admin, schema, clock)
  };
}

/** Both connections bound up front: `defineAuthorization` with `as` and `access` already connected. */
export function withAuthorization(databases: AuthorizationDatabases, options: AuthorizationOptions) {
  const authorization = defineAuthorization(options);
  return {
    as: (subject: Principal): Session => authorization.as(databases.app, subject),
    access: authorization.access(databases.admin)
  };
}
