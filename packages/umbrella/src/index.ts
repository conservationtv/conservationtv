export {
  withAccess,
  resourceScope,
  role,
  principal,
  user,
  device,
  AuthorizationError,
  type Principal,
  type ScopeRef,
  type ScopeId,
  type ActionRef,
  type RoleRef,
  type SharedRole,
  type RoleMetadata,
  type SharedRoleOptions,
  type SharedRoleRegistry,
  type ProtectedTable,
  type Operation
} from './definitions.js';
export { roleAssignments, type Assignment } from './assignments.js';
export {
  defineAuthorization,
  withAuthorization,
  type Access,
  type Authorization,
  type AuthorizationDatabases,
  type AuthorizationOptions,
  type Database,
  type Session
} from './client.js';
export { rlsMigration, rlsTeardownMigration, type RlsMigrationOptions } from './rls.js';
export type {
  AccessCatalog,
  CatalogRole,
  CatalogResource,
  CatalogAction,
  GrantQueryOptions,
  InspectQueryOptions,
  InspectOptions,
  AssignedRole,
  AssignedRoles,
  RoleMember,
  GrantedBy,
  PermissionDecision,
  PermissionMap,
  RoleKind,
  GrantStatus
} from './inspection.js';
