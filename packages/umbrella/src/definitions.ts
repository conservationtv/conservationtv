import { getColumnTable, getColumns, is } from 'drizzle-orm';
import { getTableConfig, PgColumn, type AnyPgColumn, type PgTable } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { AccessNameSchema, ScopeIdSchema, decode, type ScopeId } from './values.js';
export type { ScopeId } from './values.js';

export type Operation = 'select' | 'insert' | 'update' | 'delete';
export interface Principal<Id extends ScopeId = ScopeId, Kind extends string = string> {
  readonly kind: Kind;
  readonly id: Id;
}
export function principal<const Kind extends string, const Id extends ScopeId>(
  kind: Kind,
  id: Id
): Principal<Id, Kind> {
  validName(kind);
  validId(id);
  return { kind, id };
}
export const user = <const Id extends ScopeId>(id: Id): Principal<Id, 'user'> => principal('user', id);
export const device = <const Id extends ScopeId>(id: Id): Principal<Id, 'device'> => principal('device', id);
function validName(name: string): void {
  decode(AccessNameSchema, name);
}
function validId(id: ScopeId): void {
  decode(ScopeIdSchema, id);
}
export interface ScopeRef<N extends string = string> {
  readonly name: N;
  readonly id: ScopeId | null;
}
export const root = { name: 'global', id: null } as const satisfies ScopeRef<'global'>;
export type RootScope = typeof root;
export interface ScopeBinding<S extends AnyScope = AnyScope, C extends AnyPgColumn = AnyPgColumn> {
  readonly scope: S;
  readonly column: C;
}
type ColumnId<C extends AnyPgColumn> = Extract<C['_']['data'], ScopeId>;
export class Scope<N extends string, C extends AnyPgColumn, P extends RootScope | ScopeBinding> {
  constructor(
    readonly name: N,
    readonly key: C,
    readonly parent: P
  ) {}
  at(id: ColumnId<C>): ScopeRef<N> {
    validId(id);
    return { name: this.name, id };
  }
  via<V extends AnyPgColumn>(
    column: V & (V['_']['data'] extends C['_']['data'] ? unknown : never)
  ): ScopeBinding<this, V> {
    return { scope: this, column };
  }
}
export type AnyScope = Scope<string, AnyPgColumn, RootScope | ScopeBinding<any>>;
export type ResourceScope = RootScope | AnyScope | ScopeBinding;
interface ScopeConfig<N extends string, C extends AnyPgColumn, P extends RootScope | ScopeBinding> {
  name: N;
  key: C & (C['_']['data'] extends ScopeId ? unknown : never);
  parent: P;
}
type RootScopeConfig<N extends string, C extends AnyPgColumn> = Omit<ScopeConfig<N, C, RootScope>, 'parent'>;
export function resourceScope<const N extends string, C extends AnyPgColumn>(
  config: RootScopeConfig<N, C>
): Scope<N, C, RootScope>;
export function resourceScope<const N extends string, C extends AnyPgColumn, P extends RootScope | ScopeBinding>(
  config: ScopeConfig<N, C, P>
): Scope<N, C, P>;
export function resourceScope<const N extends string, C extends AnyPgColumn, P extends RootScope | ScopeBinding>(
  config: RootScopeConfig<N, C> | ScopeConfig<N, C, P>
): Scope<N, C, RootScope | P> {
  validName(config.name);
  if (config.name === 'global') throw new TypeError('global is reserved for the root scope');
  return new Scope(config.name, config.key, 'parent' in config ? config.parent : root);
}
export type ScopeNames<S> = S extends RootScope
  ? 'global'
  : S extends ScopeBinding<infer Node>
    ? ScopeNames<Node>
    : S extends Scope<infer Name, AnyPgColumn, infer Parent>
      ? Name | ScopeNames<Parent>
      : never;
const RoleMetadataSchema = z
  .object({
    label: z.string().min(1).optional(),
    description: z.string().nullable().optional()
  })
  .strict();
export type RoleMetadata = z.output<typeof RoleMetadataSchema>;
const SharedRoleInputSchema = RoleMetadataSchema.extend({
  assignableScopes: z.array(AccessNameSchema).min(1).optional()
});
type SharedRoleInput = z.output<typeof SharedRoleInputSchema>;
export interface SharedRoleOptions<S extends string = string> extends Omit<SharedRoleInput, 'assignableScopes'> {
  readonly assignableScopes?: readonly S[];
}
interface RootRoleOptions extends RoleMetadata {
  readonly assignableScopes?: never;
}
interface RoleDisplay {
  readonly label: string;
  readonly description: string | null;
}
function roleDisplay(name: string, options: RoleMetadata): RoleDisplay {
  const parsed = decode(RoleMetadataSchema, options);
  return { label: parsed.label ?? name, description: parsed.description ?? null };
}
export interface RoleDefinition extends RoleMetadata {
  readonly permissions: readonly string[];
  readonly assignableScopes?: readonly string[];
  readonly includedIn?: readonly SharedRole[];
}
type ScopeMap = Readonly<Record<string, ScopeEntry>>;
interface DefinitionFields {
  readonly name: string;
  readonly actions?: Readonly<Record<string, readonly Operation[]>>;
  readonly roles?: Readonly<Record<string, RoleDefinition>>;
  readonly immutable?: readonly AnyPgColumn[];
  /** Columns the application role may write but never select: secrets only trusted code reads back. */
  readonly hidden?: readonly AnyPgColumn[];
  /**
   * Actions declared so trusted code can ask who may perform them (`inspect`, `grantsQuery`), but never granted to the
   * application role: protected sessions cannot perform them at all, whatever the roles say.
   */
  readonly trusted?: readonly string[];
}
interface SingleScope {
  readonly scope?: ResourceScope;
  readonly scopes?: never;
}
interface NamedScopes {
  readonly scope?: never;
  readonly scopes: ScopeMap;
}
export type Definition = DefinitionFields & (SingleScope | NamedScopes);
interface HasScopes<S> {
  scopes: S;
}
interface HasScope<S> {
  scope: S;
}
interface DefaultScopes<S> {
  readonly default: S;
}
interface HasActions<A> {
  actions: A;
}
interface HasRoles<R> {
  roles: R;
}
interface HasAssignableScopes<S extends string> {
  assignableScopes: readonly S[];
}
interface HasIncludedRoles {
  includedIn: readonly SharedRole[];
}
type DeclaredRoleScopes<R> =
  | (R extends HasAssignableScopes<infer S> ? S : never)
  | (R extends HasIncludedRoles ? R['includedIn'][number]['assignableScopes'][number] : never);
interface InvalidRoleFields<R> {
  readonly invalidRoles: R;
}
interface InvalidDefinitionFields<F> {
  readonly invalidFields: F;
}
interface InvalidTrustedFields<T> {
  readonly invalidTrusted: T;
}
interface HasTrusted<T> {
  trusted: readonly T[];
}
type ScopesOf<D> =
  D extends HasScopes<infer S> ? S : D extends HasScope<infer S> ? DefaultScopes<S> : DefaultScopes<RootScope>;
type ScopeOf<D> = ScopesOf<D>[keyof ScopesOf<D>];
type ActionNames<D> = D extends HasActions<infer A> ? keyof A & string : never;
type RoleNames<D> = D extends HasRoles<infer R> ? keyof R & string : never;
type Allowed<D, R extends RoleNames<D>> =
  D extends HasRoles<infer Roles>
    ? Roles[R & keyof Roles] extends HasAssignableScopes<infer N>
      ? N
      : ScopeNames<ScopeOf<D>>
    : never;
type InvalidRoles<D> =
  D extends HasRoles<infer R>
    ? {
        [K in keyof R]: R[K] extends RoleDefinition
          ? Exclude<keyof R[K], keyof RoleDefinition> extends never
            ? Exclude<R[K]['permissions'][number], ActionNames<D>> extends never
              ? Exclude<DeclaredRoleScopes<R[K]>, ScopeNames<ScopeOf<D>>> extends never
                ? never
                : K
              : K
            : K
          : K;
      }[keyof R]
    : never;
type InvalidTrusted<D> = D extends HasTrusted<infer T> ? Exclude<T, ActionNames<D>> : never;
type Validate<D> = (InvalidRoles<D> extends never ? unknown : InvalidRoleFields<InvalidRoles<D>>) &
  (InvalidTrusted<D> extends never ? unknown : InvalidTrustedFields<InvalidTrusted<D>>) &
  (Exclude<keyof D, keyof Definition> extends never
    ? unknown
    : InvalidDefinitionFields<Exclude<keyof D, keyof Definition>>);

export interface ActionRef<T extends PgTable = PgTable, N extends string = string> {
  readonly resource: string;
  readonly name: N;
  readonly table: T;
}
export interface RoleRef<N extends string = string, S extends string = string> extends RoleDisplay {
  readonly resource: string;
  readonly name: N;
  readonly assignableScopes: readonly S[];
}
export const sharedResource = '@shared';
export interface SharedRole<N extends string = string, S extends string = string> extends RoleRef<N, S> {
  readonly resource: typeof sharedResource;
}
const sharedRoles = new WeakMap<RoleRef, ApplicableRole>();
/** Shared roles have stable names and explicit scope levels, defaulting to root. */
export function role<const N extends string, const S extends string>(
  name: N,
  options: SharedRoleOptions<S> & HasAssignableScopes<S>
): SharedRole<N, S>;
export function role<const N extends string>(name: N, options?: RootRoleOptions): SharedRole<N, 'global'>;
export function role<const N extends string, const S extends string>(
  name: N,
  options: SharedRoleOptions<S>
): SharedRole<N, S | 'global'>;
export function role(name: string, options: SharedRoleOptions = {}): SharedRole {
  validName(name);
  const parsed = decode(SharedRoleInputSchema, options);
  const display = roleDisplay(name, { label: parsed.label, description: parsed.description });
  const scopes = [...new Set(parsed.assignableScopes ?? ['global'])];
  const ref: SharedRole = { resource: sharedResource, name, assignableScopes: [...scopes], ...display };
  sharedRoles.set(ref, { resource: sharedResource, name, scopes, ...display });
  return ref;
}
function sharedRole(ref: SharedRole): ApplicableRole {
  const registered = sharedRoles.get(ref);
  if (!registered) throw new TypeError('Use a shared role reference created by role()');
  return registered;
}
type ActionRefs<T extends PgTable, D> = { readonly [N in ActionNames<D>]: ActionRef<T, N> };
type RoleRefs<D> = { readonly [R in RoleNames<D>]: RoleRef<R, Allowed<D, R>> };
interface AccessMarker<D = Definition> {
  readonly _definition?: D;
}
interface AccessDescriptor<T extends PgTable, D extends Definition> extends AccessMarker<D> {
  readonly name: D['name'];
  readonly scopes: Readonly<ScopesOf<D>>;
  readonly actions: ActionRefs<T, D>;
  readonly roles: RoleRefs<D>;
}
type TableAccess<T extends PgTable, D extends Definition> = {
  readonly $access: AccessDescriptor<T, D> & (D extends HasScope<infer S> ? HasScope<S> : unknown);
};
export type ProtectedTable<T extends PgTable = PgTable, D extends Definition = Definition> = T & TableAccess<T, D>;
interface ProtectedMarker {
  readonly $access: AccessMarker;
}
export type AnyProtectedTable = PgTable & ProtectedMarker;
export type DefinitionOf<T> = T extends ProtectedMarker ? NonNullable<T['$access']['_definition']> : never;

export interface Metadata {
  readonly table: PgTable;
  readonly name: string;
  readonly scopes: Readonly<Record<string, ResourceScope>>;
  readonly columns: Record<string, AnyPgColumn>;
  readonly actions: Readonly<Record<string, readonly Operation[]>>;
  readonly roles: Readonly<Record<string, StoredRole>>;
  readonly roleRefs: ReadonlyMap<string, RoleRef>;
  readonly immutable: ReadonlySet<string>;
  readonly hidden: ReadonlySet<string>;
  readonly trusted: ReadonlySet<string>;
  readonly operationActions: ReadonlyMap<Operation, string>;
}
const metadata = new WeakMap<PgTable, Metadata>();
function getAccess(table: PgTable): Metadata {
  const result = metadata.get(table);
  if (!result) throw new TypeError('Table has no access definition');
  return result;
}
function hasAccess(value: PgTable): value is AnyProtectedTable {
  return metadata.has(value);
}
export function scopeNames(scope: ResourceScope): string[] {
  if (scope === root) return ['global'];
  const node = scopeNode(scope);
  return [node.name, ...scopeNames(node.parent)];
}
export function columnKey(table: PgTable, column: AnyPgColumn): string {
  const key = Object.keys(getColumns(table)).find(k => getColumns(table)[k] === column);
  if (!key) throw new TypeError('Access column must belong to its table');
  return key;
}

/** Root identity is checked before narrowing the two non-root scope variants. */
function scopeNode(scope: ResourceScope): AnyScope {
  if (scope instanceof Scope) return scope;
  if ('scope' in scope) return scope.scope;
  throw new TypeError('Root scope has no node');
}
function scopeColumn(scope: ResourceScope): AnyPgColumn {
  if (scope instanceof Scope) return scope.key;
  if ('column' in scope) return scope.column;
  throw new TypeError('Root scope has no column');
}
export function parentBinding(scope: AnyScope): ScopeBinding | undefined {
  return 'column' in scope.parent ? scope.parent : undefined;
}
const ScopeEntrySchema = z.union([
  z.custom<RootScope>(value => value === root),
  z.instanceof(Scope),
  z.object({ scope: z.instanceof(Scope), column: z.custom<AnyPgColumn>(value => is(value, PgColumn)) })
]);
type ScopeEntry = z.output<typeof ScopeEntrySchema>;
const NamedScopeMapSchema = z.record(AccessNameSchema, ScopeEntrySchema).refine(value => Object.keys(value).length > 0);
type NamedScopeMap = z.output<typeof NamedScopeMapSchema>;

/** Default to global access, or validate the chosen scope declaration against its table. */
function definitionScopes(config: Definition, table: PgTable) {
  if (config.scope !== undefined && config.scopes !== undefined) throw new TypeError('Define either scope or scopes');
  const scopes: NamedScopeMap = decode(NamedScopeMapSchema, config.scopes ?? { default: config.scope ?? root });
  for (const scope of Object.values(scopes)) if (scope !== root) columnKey(table, scopeColumn(scope));
  return { ...scopes };
}
function definitionActions(config: Definition, table: PgTable) {
  const actions: Record<string, readonly Operation[]> = Object.create(null);
  const refs = new Map<string, ActionRef>();
  const operationActions = new Map<Operation, string>();
  // Each operation has a single permission owner; copies detach the caller's arrays.
  for (const [name, operations] of Object.entries(config.actions ?? {})) {
    validName(name);
    for (const op of operations) {
      if (!['select', 'insert', 'update', 'delete'].includes(op) || operationActions.has(op)) {
        throw new TypeError(`Each operation must belong to exactly one action: ${op}`);
      }
      operationActions.set(op, name);
    }
    actions[name] = [...operations];
    refs.set(name, { resource: config.name, name, table });
  }
  return { actions, refs, operationActions };
}
function validateRole(
  role: RoleDefinition,
  name: string,
  actions: Readonly<Record<string, readonly Operation[]>>,
  scopes: readonly string[],
  allowed: readonly string[]
): void {
  // Validate permission names and assignment scopes before registering the role.
  for (const key of Object.keys(role))
    if (!['permissions', 'assignableScopes', 'includedIn', 'label', 'description'].includes(key))
      throw new TypeError(`Unknown role field: ${key}`);
  if (
    !role.permissions.length ||
    !scopes.length ||
    role.permissions.some(permission => !Object.hasOwn(actions, permission)) ||
    scopes.some(scope => !allowed.includes(scope))
  ) {
    throw new TypeError(`Invalid role: ${name}`);
  }
}
interface StoredRole extends RoleDefinition {
  readonly label: string;
  readonly description: string | null;
  readonly assignableScopes: readonly string[];
  readonly includedIn: readonly SharedRole[];
}
/** Validate copied memberships and scope restrictions independently of display metadata. */
function copyRole(
  definition: RoleDefinition,
  name: string,
  actions: Readonly<Record<string, readonly Operation[]>>,
  allowed: readonly string[]
): StoredRole {
  const scopes = definition.assignableScopes ?? allowed;
  validateRole(definition, name, actions, scopes, allowed);
  if (definition.includedIn !== undefined && !Array.isArray(definition.includedIn))
    throw new TypeError('includedIn must be an array of shared role references');
  const includedIn = [...new Set(definition.includedIn ?? [])];
  for (const ref of includedIn)
    if (sharedRole(ref).scopes.some(scope => !allowed.includes(scope)))
      throw new TypeError(`Shared role ${ref.name} has a scope not bound to this resource`);
  return {
    permissions: [...new Set(definition.permissions)],
    assignableScopes: [...new Set(scopes)],
    includedIn,
    ...roleDisplay(name, { label: definition.label, description: definition.description })
  };
}
/** Copy direct scope restrictions and validate shared memberships before exposing role references. */
function definitionRoles(
  config: Definition,
  actions: Readonly<Record<string, readonly Operation[]>>,
  bindings: ScopeMap
) {
  const allowed = [...new Set(Object.values(bindings).flatMap(scopeNames))];
  const roles: Record<string, StoredRole> = Object.create(null);
  const refs = new Map<string, RoleRef>();
  for (const [name, role] of Object.entries(config.roles ?? {})) {
    validName(name);
    const stored = copyRole(role, name, actions, allowed);
    roles[name] = stored;
    refs.set(name, {
      resource: config.name,
      name,
      assignableScopes: [...stored.assignableScopes],
      label: stored.label,
      description: stored.description
    });
  }
  return { roles, refs };
}
function immutableColumns(config: Definition, table: PgTable, scopes: ScopeMap): ReadonlySet<string> {
  const keys = new Set((config.immutable ?? []).map(column => columnKey(table, column)));
  // A row cannot move between bindings or ancestors through a protected update.
  for (const scope of Object.values(scopes)) {
    if (scope === root) continue;
    keys.add(columnKey(table, scopeColumn(scope)));
    const parent = scope instanceof Scope ? parentBinding(scope) : undefined;
    if (parent) keys.add(columnKey(table, parent.column));
  }
  return keys;
}
function trustedActions(
  config: Definition,
  actions: Readonly<Record<string, readonly Operation[]>>
): ReadonlySet<string> {
  // A trusted action must be one the table declares; an absent list trusts nothing.
  if (config.trusted !== undefined && !Array.isArray(config.trusted)) throw new TypeError('trusted must be an array');
  for (const name of config.trusted ?? [])
    if (!Object.hasOwn(actions, name)) throw new TypeError(`Unknown trusted action: ${name}`);
  return new Set(config.trusted);
}
interface PublicAccess {
  name: string;
  scopes: ScopeMap;
  scope?: ResourceScope;
  actions: Record<string, ActionRef>;
  roles: Record<string, RoleRef>;
}
/** Compile copied definitions before exposing typed descriptors on the original table. */
export function withAccess<T extends PgTable, const D extends Definition>(
  table: T,
  define: (table: T) => D & Validate<D>
): ProtectedTable<T, D> {
  if (metadata.has(table) || '$access' in table) throw new TypeError('Access is already defined on this table');
  const config = define(table);
  for (const key of Object.keys(config))
    if (!['name', 'scope', 'scopes', 'actions', 'roles', 'immutable', 'hidden', 'trusted'].includes(key))
      throw new TypeError(`Unknown access field: ${key}`);
  validName(config.name);
  const scopes = definitionScopes(config, table);
  const actions = definitionActions(config, table);
  const roles = definitionRoles(config, actions.actions, scopes);
  metadata.set(table, {
    table,
    name: config.name,
    scopes,
    columns: getColumns(table),
    actions: actions.actions,
    roles: roles.roles,
    roleRefs: roles.refs,
    immutable: immutableColumns(config, table, scopes),
    hidden: new Set((config.hidden ?? []).map(column => columnKey(table, column))),
    trusted: trustedActions(config, actions.actions),
    operationActions: actions.operationActions
  });
  const access: PublicAccess = {
    name: config.name,
    scopes: { ...scopes },
    actions: Object.fromEntries(actions.refs),
    roles: Object.fromEntries(roles.refs)
  };
  if (config.scope !== undefined) access.scope = config.scope;
  Object.defineProperty(table, '$access', { value: access, enumerable: false });
  // SAFETY: The descriptor was installed above from this table's validated, inferred definition.
  return table as ProtectedTable<T, D>;
}

export class AuthorizationError extends Error {
  constructor(message = 'Access denied') {
    super(message);
    this.name = 'AuthorizationError';
  }
}

export type TableSchema = Readonly<Record<string, PgTable>>;
export type SharedRoleRegistry = Readonly<Record<string, SharedRole>>;
export interface ApplicableRole extends RoleDisplay {
  readonly resource: string;
  readonly name: string;
  readonly scopes: readonly string[];
}
export interface PermissionContribution {
  readonly grantResource: string;
  readonly grantRole: string;
  readonly resource: string;
  readonly tableRole: string;
  readonly scopeName: string;
  readonly permission: string;
}
export interface OperationAccess {
  readonly metadata: Metadata;
  readonly operation: Operation;
  readonly permission: string;
  readonly contributions: readonly PermissionContribution[];
}
/** Expand direct and shared grants once, retaining the local role that contributes each permission. */
function contributions(meta: Metadata): readonly PermissionContribution[] {
  const rows = new Map<string, PermissionContribution>();
  for (const [tableRole, definition] of Object.entries(meta.roles)) {
    const grants = [
      { resource: meta.name, name: tableRole, scopes: definition.assignableScopes },
      ...definition.includedIn.map(sharedRole)
    ];
    for (const grant of grants)
      for (const scopeName of grant.scopes)
        for (const permission of definition.permissions) {
          const row = {
            grantResource: grant.resource,
            grantRole: grant.name,
            resource: meta.name,
            tableRole,
            scopeName,
            permission
          };
          rows.set(JSON.stringify(row), row);
        }
  }
  return [...rows.values()];
}

function uniqueKey(column: AnyPgColumn): boolean {
  const config = getTableConfig(getColumnTable<PgTable>(column));
  // A single-column key identifies exactly one scope row; partial indexes do not.
  return (
    column.primary ||
    column.isUnique ||
    config.primaryKeys.some(key => key.columns.length === 1 && key.columns[0] === column) ||
    config.uniqueConstraints.some(key => key.columns.length === 1 && key.columns[0] === column) ||
    config.indexes.some(index => {
      // Require an unconditional unique index over this column rather than an expression.
      return (
        index.config.unique &&
        !index.config.where &&
        index.config.columns.length === 1 &&
        'name' in index.config.columns[0]! &&
        index.config.columns[0]!.name === column.name
      );
    })
  );
}

/** Static definitions are validated and indexed once per client. */
export class AccessSchema {
  private readonly resources = new Map<string, Metadata>();
  readonly scopes = new Map<string, AnyScope>();
  private readonly permissions = new Map<PgTable, readonly PermissionContribution[]>();
  private readonly tables = new Set<PgTable>();
  private readonly roles = new Map<RoleRef, ApplicableRole>();
  private readonly shared = new Map<string, ApplicableRole>();

  constructor(schema: TableSchema, registry: SharedRoleRegistry = {}) {
    // Collect all protected tables before resolving foreign scope references.
    for (const table of Object.values(schema)) if (hasAccess(table)) this.registerTable(table);
    if (!this.resources.size) throw new TypeError('Schema has no protected tables');
    for (const ref of Object.values(registry)) this.registerShared(ref);
    for (const meta of this.resources.values()) this.registerDefinition(meta);
    for (const role of this.shared.values()) this.validateSharedScopes(role);
  }
  private registerShared(ref: SharedRole): void {
    const registered = sharedRole(ref);
    this.validateShared(registered);
    this.shared.set(registered.name, registered);
  }
  private validateShared(role: ApplicableRole): void {
    // A persisted shared name has one definition; scope order is irrelevant, but its set and display metadata must agree.
    const existing = this.shared.get(role.name);
    if (
      existing &&
      (existing.label !== role.label ||
        existing.description !== role.description ||
        existing.scopes.length !== role.scopes.length ||
        role.scopes.some(scope => !existing.scopes.includes(scope)))
    )
      throw new TypeError(`Conflicting shared role definition: ${role.name}`);
  }
  private validateSharedScopes(role: ApplicableRole): void {
    for (const scope of role.scopes)
      if (scope !== root.name && !this.scopes.has(scope)) throw new TypeError(`Unknown shared role scope: ${scope}`);
  }
  entries(): readonly Metadata[] {
    return [...this.resources.values()];
  }
  sharedEntries(): readonly ApplicableRole[] {
    return [...this.shared.values()];
  }
  table(table: PgTable): Metadata {
    if (!this.tables.has(table)) throw new TypeError("Table is not registered in this client's schema");
    return getAccess(table);
  }
  scope(ref: ScopeRef): ScopeRef {
    // Root has no ID; every other context identifies a registered scope with a valid key.
    if (ref.name === root.name) {
      if (ref.id !== null) throw new TypeError('Root scope has no ID');
    } else {
      if (!this.scopes.has(ref.name) || ref.id === null) throw new TypeError('Unknown scope');
      validId(ref.id);
    }
    return { ...ref };
  }
  private registerTable(table: PgTable): void {
    const meta = getAccess(table);
    const existing = this.resources.get(meta.name);
    if (existing && existing !== meta) throw new TypeError(`Duplicate resource: ${meta.name}`);
    this.resources.set(meta.name, meta);
    this.tables.add(table);
  }
  private registerScope(scope: ResourceScope, path = new Set<AnyScope>()): void {
    // Resolve each scope once while checking the current path separately for cycles.
    if (scope === root) return;
    const node = scopeNode(scope);
    if (path.has(node)) throw new TypeError('Cyclic scope hierarchy');
    if (!this.tables.has(getColumnTable(node.key)))
      throw new TypeError(`Register the table defining scope ${node.name}`);
    const existing = this.scopes.get(node.name);
    if (existing === node) return;
    if (existing) throw new TypeError(`Duplicate scope: ${node.name}`);
    this.validateNode(node);
    this.scopes.set(node.name, node);
    const next = new Set(path);
    next.add(node);
    this.registerScope(node.parent, next);
  }
  private validateNode(node: AnyScope): void {
    // Scope identity and ancestry require non-null keys on the declaring table.
    if (!node.key.notNull) throw new TypeError('Scope keys must be non-null');
    if (!uniqueKey(node.key)) throw new TypeError('A scope key must have a single-column primary or unique key');
    if (!Object.values(getAccess(getColumnTable(node.key)).scopes).includes(node))
      throw new TypeError("A scope must be defined on its key's table");
    const parent = parentBinding(node);
    if (!parent) return;
    columnKey(getColumnTable(node.key), parent.column);
    if (!parent.column.notNull) throw new TypeError('Scope parent links must be non-null');
  }
  private registerDefinition(meta: Metadata): void {
    // Build permission and reference indexes after validating every binding.
    for (const scope of Object.values(meta.scopes)) {
      this.registerScope(scope);
      if ('column' in scope && !scope.column.notNull) throw new TypeError('Resource scope links must be non-null');
    }
    for (const definition of Object.values(meta.roles))
      for (const ref of definition.includedIn) this.registerShared(ref);
    this.permissions.set(meta.table, contributions(meta));
    for (const [name, ref] of meta.roleRefs) {
      const definition = meta.roles[name]!;
      this.roles.set(ref, {
        resource: meta.name,
        name,
        scopes: definition.assignableScopes,
        label: definition.label,
        description: definition.description
      });
    }
  }
  role(ref: RoleRef): ApplicableRole {
    const role = this.roles.get(ref) ?? sharedRoles.get(ref);
    if (!role) throw new TypeError('Use a role reference from a registered table or role()');
    if (role.resource === sharedResource) {
      this.validateShared(role);
      this.validateSharedScopes(role);
    }
    return role;
  }
  contributions(table: PgTable): readonly PermissionContribution[] {
    this.table(table);
    return this.permissions.get(table)!;
  }
  lookupRole(resource: string, name: string): ApplicableRole | undefined {
    if (resource === sharedResource) return this.shared.get(name);
    const ref = this.resources.get(resource)?.roleRefs.get(name);
    return ref ? this.roles.get(ref) : undefined;
  }
  operation(table: PgTable, operation: Operation): OperationAccess {
    const metadata = this.table(table);
    const permission = metadata.operationActions.get(operation);
    if (!permission) throw new AuthorizationError(`No permission protects ${operation} on ${metadata.name}`);
    return { metadata, operation, permission, contributions: this.permissions.get(table)! };
  }
}
