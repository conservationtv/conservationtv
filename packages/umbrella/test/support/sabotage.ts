import { sql } from 'drizzle-orm';
import { roleAssignments } from '../../src/index.js';
import type { Harness } from './harness.js';
import { VAULT } from './schema.js';

/** A deliberate fault in the database: weakened policies, dropped protections, or corrupt authorization data. */
export interface Sabotage {
  readonly name: string;
  apply(h: Harness): Promise<void>;
}
const statement = (name: string, text: string): Sabotage => ({
  name,
  async apply(h) {
    await h.pg.exec(text);
  }
});

export const permissiveReadPolicy = statement(
  'the tasks read policy allows every row',
  `drop policy authz_select on tasks; create policy authz_select on tasks for select using (true);`
);
export const permissiveInsertPolicy = statement(
  'the tasks insert policy allows every row',
  `drop policy authz_insert on tasks; create policy authz_insert on tasks for insert with check (true);`
);
export const permissiveProjectInsertPolicy = statement(
  'the projects insert policy allows every row',
  `drop policy authz_insert on projects; create policy authz_insert on projects for insert with check (true);`
);
export const tasksUnprotected = statement(
  'row-level security is disabled on tasks',
  `alter table tasks disable row level security;`
);
export const keyFunctionReturnsAll = statement(
  'the tasks read key function returns every project',
  `create or replace function "authz:tasks:select:0"() returns setof text language sql stable security definer
     as $$ select id from projects $$;`
);
export const immutableTriggerDropped = statement(
  'the immutable-column trigger on tasks is dropped',
  `drop trigger authz_immutable on tasks;`
);
export const assignmentsUnprotected = statement(
  'row-level security is disabled on assignments',
  `alter table authz_role_assignments disable row level security;`
);
export const projectReparented = statement(
  "Globex's project is re-parented under Acme",
  `update projects set organisation_id = 'acme' where id = 'gemini';`
);
export const grantsMovedToApollo = statement(
  'stored grants are moved to the Apollo project',
  `update authz_role_assignments set scope_name = 'project', scope_id = 'apollo';`
);
export const expiryCleared = statement(
  'grant expiry dates are cleared',
  `update authz_role_assignments set expires_at = null;`
);

/** A grant written straight into the assignments table, bypassing the administration API. */
function strayGrant(name: string, role: string, scopeName: string, scopeId: string): Sabotage {
  return {
    name,
    async apply(h) {
      await h.raw
        .insert(roleAssignments)
        .values({ principalKind: 'user', principalId: 'alice', resource: 'tasks', role, scopeName, scopeId });
    }
  };
}
export const strayGlobalViewer = strayGrant('a stray global viewer grant for the principal', 'viewer', 'global', '');
export const strayZeusEditor = strayGrant('a stray Zeus editor grant for the principal', 'editor', 'project', 'zeus');
export const nonCanonicalScopeId: Sabotage = {
  name: 'a grant stored with a non-canonical scope ID',
  async apply(h) {
    await h.raw.execute(sql`insert into authz_role_assignments
      (principal_kind, principal_id, resource, role, scope_name, scope_id)
      values ('user', 'alice', 'vaults', 'keeper', 'vault', ${VAULT.toUpperCase()})`);
  }
};
