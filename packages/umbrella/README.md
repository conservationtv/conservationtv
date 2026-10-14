# @conservationtv/umbrella

Table-local, typed authorization for Drizzle ORM and PostgreSQL. Each table declares its actions, roles, and the scope its rows belong to. Grants stored in the database decide who receives those roles and where. The definitions compile to PostgreSQL row-level security (RLS), so request handlers can run ordinary Drizzle queries, including joins, aggregates, and raw SQL, and only ever see or change rows they are allowed to.

The package supports typed table roles and shared roles, hierarchical scopes, multiple scope bindings per table, time-limited grants, role catalogs, and composable access reports. It requires PostgreSQL 15 or newer and a Drizzle PostgreSQL driver with transactions.

**Read the [usage guide](GUIDE.md)** for the concepts, a step-by-step setup, recipes for common access problems (organisation administrators, single-record access, users editing their own data, member directories, comments and authorship, devices, temporary access, offboarding), and administration reports.

## Installation

This is a workspace package, consumed from source: depend on `"@conservationtv/umbrella": "workspace:*"` alongside `drizzle-orm` 1.0. It was copied from the `@strangecyan/umbrella` experiment (`~/Developer/experiments/umbrella`) with its publishing, benchmark and lint tooling removed.

Requires Node 22.18 or newer. The optional `umbrella generate` command uses your project's `drizzle-kit` 1.0 installation.

## At a glance

```ts
// roles.ts
import { role } from '@conservationtv/umbrella';

export const organisationAdmin = role('organisationAdmin', {
  label: 'Organisation administrator',
  assignableScopes: ['organisation']
});
```

```ts
// schema.ts
import { pgTable, text } from 'drizzle-orm/pg-core';
import { resourceScope, roleAssignments, withAccess } from '@conservationtv/umbrella';
import { organisationAdmin } from './roles.js';

export { roleAssignments };

export const organisations = withAccess(
  pgTable('organisations', { id: text().primaryKey(), name: text().notNull() }),
  t => ({
    name: 'organisations',
    scope: resourceScope({ name: 'organisation', key: t.id })
  })
);

export const projects = withAccess(
  pgTable('projects', {
    id: text().primaryKey(),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organisations.id),
    name: text().notNull()
  }),
  t => ({
    name: 'projects',
    scope: resourceScope({
      name: 'project',
      key: t.id,
      parent: organisations.$access.scope.via(t.organisationId)
    }),
    actions: { read: ['select'], write: ['insert', 'update'], remove: ['delete'] },
    roles: {
      reader: { permissions: ['read'], assignableScopes: ['project'] },
      admin: {
        permissions: ['read', 'write', 'remove'],
        assignableScopes: ['project'],
        includedIn: [organisationAdmin]
      }
    }
  })
);
```

```ts
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { defineAuthorization, user } from '@conservationtv/umbrella';
import * as schema from './schema.js';

// Compiled once; connections are supplied where they are used.
const authorization = defineAuthorization({ schema });
const appDb = drizzle(process.env.APP_DATABASE_URL!);
const adminDb = drizzle(process.env.ADMIN_DATABASE_URL!);

// Trusted provisioning code, using the admin connection.
const access = authorization.access(adminDb);
await access.at(organisations.$access.scope.at('acme')).grant({ principal: user('alice'), role: organisationAdmin });
await access.at(projects.$access.scope.at('apollo')).grant({
  principal: user('bob'),
  role: projects.$access.roles.reader
});

// A request handler, using only the application connection.
const visible = await authorization.as(appDb, user('bob')).transaction(tx => tx.select().from(projects)); // Apollo only
const renamed = await authorization
  .as(appDb, user('alice'))
  .transaction(tx => tx.update(projects).set({ name: 'Apollo 2' }).where(eq(projects.id, 'apollo')).returning());
```

Alice's single grant at Acme covers every Acme project, including projects created later. Bob reads Apollo and nothing else. `withAccess` returns the original Drizzle table with a readonly `$access` descriptor, so column inference, foreign keys, and ordinary migrations are unchanged.

## Concepts

- **Principal:** who is asking: `user('alice')`, `device(1)`, or `principal('service', 'billing')`. Authenticate first; these constructors do not authenticate anyone.
- **Action:** a named permission on one table, mapped to SQL operations. Each operation belongs to at most one action; an operation without an action is denied to every request session.
- **Scope:** where a grant applies. The global root always exists; tables define further scopes with `resourceScope({ name, key, parent })` and bind rows to a scope through a foreign key with `.via(column)`. A grant covers its scope and every descendant.
- **Table role:** a bundle of one table's actions, with the scopes it can be granted at.
- **Shared role:** declared once with `role(name)`; table roles opt in with `includedIn`, so one grant supplies every participating table's permissions.
- **Grant:** a stored assignment of a role to a principal at a scope, optionally between `startsAt` (inclusive) and `expiresAt` (exclusive). Grants are additive.

## Setup

1. Export `roleAssignments` from your migration schema, or apply [migrations/0000_authz.sql](migrations/0000_authz.sql).
2. Run `umbrella generate` after `drizzle-kit generate`. It writes the compiled policies into a Drizzle Kit custom migration whenever your access definitions change, and does nothing otherwise. Each of these migrations replaces everything the previous one created, so applying several in a row leaves exactly the latest rules. Without Drizzle Kit, apply the SQL from `rlsMigration(schema)` as the tables' owner after your table migrations.
3. Create a login role for the application that is not a superuser, does not have `BYPASSRLS`, and is not a member of the tables' owner. Grant it only the table and column privileges your queries need, and no access to `authz_role_assignments`.
4. Compile the definitions with `defineAuthorization({ schema, roles? })`. Request handlers use `as(appDb, principal)`; trusted code uses `access(adminDb)`. `withAuthorization({ app, admin }, options)` binds both connections up front when that is more convenient. The first session transaction over each connection refuses one that could bypass RLS.

The [guide's setup walkthrough](GUIDE.md#set-up-from-scratch) covers each step, including how to change a scope key or link column with `generate --before`.

## Request sessions

```ts
const session = secured.as(ctx.principal);

const rows = await session.transaction(async tx => {
  await tx.insert(metrics).values({ deviceId: 1, value: 42 });
  return tx.select().from(metrics).where(eq(metrics.deviceId, 1));
});
```

`session.transaction(run, config?)` sets the principal for that transaction only and runs any Drizzle query under the generated policies:

- Reads, counts, and joins include only rows the principal can read; each joined table applies its own policies.
- Updates and deletes affect only permitted rows. An empty result can mean no match or no access.
- An insert the principal cannot perform fails with PostgreSQL's row-level security error (SQLSTATE `42501`) and rolls back the transaction.
- Scope keys, scope links, parent links, and columns listed in `immutable: [t.column]` cannot be changed by a request session, which fails with the same error code. Trusted code using the admin connection can still change them.

A session keeps its connection's Drizzle type, so a connection created with `drizzle({ client, relations })` gets typed relational queries: `tx.query.projects.findMany({ with: { organisation: true } })`. Each related table applies its own policies, so a related row the principal cannot read is `null`, or missing from its list.

Checks read current grants in the same statement as the query. There is no permission cache; normal transaction isolation applies, so a long repeatable-read transaction keeps seeing the grants it started with.

## Scopes and bindings

```ts
scope: resourceScope({
  name: 'device',
  key: t.id,
  parent: organisations.$access.scope.via(t.organisationId)
});
```

Tables without `scope` or `scopes` are global. A scope with no `parent` sits directly under the global root. Scope names must be unique within a schema, and `global` is reserved. Every scope-defining table must be registered in the client's `schema`.

Use `scopes` for several named bindings. Access through any binding is enough, including inherited roles:

```ts
scopes: {
  document: documents.$access.scope.via(t.documentId),
  author: users.$access.scope.via(t.authorId),
}
```

Bindings are available as `table.$access.scopes.document`; a single `scope` is exposed as `$access.scopes.default`. Define either `scope` or `scopes`. Binding aliases are table-local, so renaming one needs no grant migration.

A scope key must be a non-null, single-column primary or unique key. Scope and parent links must be non-null. Resource and scope names are stored in grants: renaming one requires migrating its grants.

## Shared roles

```ts
export const admin = role('admin', { label: 'Administrator' });
export const organisationAdmin = role('organisationAdmin', { assignableScopes: ['organisation'] });
```

`role(name)` can be granted globally by default; `assignableScopes` replaces that default, so use `['global', 'organisation']` to allow both. Every scope a shared role declares must be reachable from each participating table's bindings or their ancestors. TypeScript and runtime validation reject mismatches.

A table role can belong to several shared roles. When another table opts into an existing shared role, current holders gain its permissions once the updated definitions and policies are deployed, with no new grants. Shared roles can be granted before any table includes them, but provide no access until one does. Table roles with the same name on different tables remain distinct, and revoking a shared grant leaves direct table-role grants intact. Keep shared role exports in their own module, separate from the table `schema`.

## Granting and revoking

```ts
const apollo = projects.$access.scope.at('apollo');

const grant = await secured.access.at(apollo).grant({
  principal: user('bob'),
  role: projects.$access.roles.reader,
  expiresAt: new Date('2026-12-01T00:00:00Z')
});

await secured.access.root().grant({ principal: user('alice'), role: admin });
await secured.access.at(apollo).list({ includeInherited: true });
await secured.access.revoke(grant.id);
await secured.access.at(apollo).revoke({ principal: user('bob'), role: projects.$access.roles.reader });
await secured.access.at(apollo).revoke({ principal: user('bob') });
await secured.access.at(apollo).all.revoke();
```

The scope row must exist when granting. `grant` is idempotent for the same principal, role, scope, and validity window: repeated or concurrent calls return the existing assignment. Different windows are separate grants; to change a window, grant the new one and revoke the old. `revoke(id)` removes one grant, `at(scope).revoke({ principal, role })` removes all of that role's windows at the scope, `at(scope).revoke({ principal })` all of the principal's grants there, and `at(scope).all.revoke()` every grant there, for deleting the scope's row.

Principal IDs are nonempty strings or safe integers, stored as text: `device(1)` and `device('1')` are the same principal, while `user(1)` and `device(1)` are different. Constructors preserve the ID type, so `device(1).id` can be passed to an integer-keyed scope.

## Catalogs and reports

`secured.access` also provides administration reports that read through the admin connection:

- `catalog()` lists resources, actions, table roles, and shared roles from the loaded definitions, without a database query. Register otherwise unused shared roles through the `roles` option to include them.
- `grantsQuery({ principal?, role?, resource?, scope?, active?, now? })` is a typed Drizzle select of stored grants, with catalog labels, `active`, `status`, and `known` for roles no longer defined.
- `inspectQuery({ resource, scope, principal?, now? })` is a typed select with one row per principal and arrays of their effective roles and permissions at that scope, including shared and inherited grants.
- `inspect({ principal, resource, scope, now? })` explains one principal's decision for every action, with the grants and roles that supplied it.

The query builders can be aliased and joined to your own tables, for example to list every user with their roles, or every user who can write a project. See [Administer and report on access](GUIDE.md#administer-and-report-on-access) for complete examples.

Reports describe the resource and scope you supply, not every route to an individual row through other bindings; request sessions enforce all of them.

## Deliberate boundaries

Give request handlers only `secured.as(principal)`. `secured.access` and the admin connection are privileged; protect any endpoint that uses them. The application remains responsible for:

- authenticating principals and deciding who may manage grants;
- creating scope rows before granting at them, and granting roles at sign-up, invitation, and similar events;
- setting ownership columns such as `authorId` from the session's principal, since policies check where a row belongs, not who it claims to belong to;
- revoking grants and deleting rows when access should end, and not reusing scope or principal IDs while old grants remain;
- migrating grants when resource, scope, or shared role names change, and generating a new access-policy migration when definitions change.

## Development

```sh
pnpm --filter @conservationtv/umbrella demo        # Runnable example using PGlite.
pnpm --filter @conservationtv/umbrella test        # Vitest against PGlite; the proof tests use Docker (Testcontainers).
pnpm --filter @conservationtv/umbrella typecheck
```

Formatting and linting use the workspace's Oxfmt and Oxlint configuration.
