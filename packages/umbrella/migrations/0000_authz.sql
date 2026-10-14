CREATE TABLE authz_role_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_kind text NOT NULL,
  principal_id text NOT NULL,
  resource text NOT NULL,
  role text NOT NULL,
  scope_name text NOT NULL,
  scope_id text NOT NULL,
  starts_at timestamptz,
  expires_at timestamptz,
  CONSTRAINT authz_unique_grant UNIQUE NULLS NOT DISTINCT (
    principal_kind, principal_id, resource, role, scope_name, scope_id, starts_at, expires_at
  )
);
CREATE INDEX authz_principal_lookup
  ON authz_role_assignments (principal_kind, principal_id, resource, role);
CREATE INDEX authz_scope_lookup ON authz_role_assignments (scope_name, scope_id);
