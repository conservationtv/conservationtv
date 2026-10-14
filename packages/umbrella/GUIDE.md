# Usage guide

This guide explains how `@conservationtv/umbrella` thinks about access, walks through adding it to an application from scratch, and then shows how to solve common access problems with it. The final sections cover administration: role pickers, "who has access?" screens, and revoking access.

- [How it works](#how-it-works) introduces the handful of concepts everything else builds on.
- [Set up from scratch](#set-up-from-scratch) takes an empty project to an enforced, request-scoped query.
- [Solve common access problems](#solve-common-access-problems) is a set of recipes. Start from the problem that looks like yours.
- [Administer and report on access](#administer-and-report-on-access) covers catalogs, grant lists, and explanations.
- [Boundaries and lifecycle](#boundaries-and-lifecycle) lists what the library deliberately leaves to your application.

Module paths such as `./db.js`, `./schema.js`, and `./roles.js` refer to modules in your application. Library APIs are imported from `@conservationtv/umbrella`.

## How it works

You describe access next to each Drizzle table. Your application stores who has been given which role, and where. PostgreSQL row-level security (RLS) enforces the result on every query a request makes, so handlers can use ordinary Drizzle queries, including joins, and see only rows they are allowed to see.

### Concepts

**Principal.** Whoever is making the request: `user('alice')`, `device(1)`, or any custom kind such as `principal('service', 'billing')`. Your authentication layer decides who the principal is; the library trusts what you pass it.

**Protected table.** A Drizzle table wrapped with `withAccess`. It is still a normal Drizzle table: inference, foreign keys, and migrations are unchanged.

**Action.** A named permission on one table, mapped to the SQL operations it allows, such as `read: ['select']` or `write: ['insert', 'update']`. An operation with no action can never be performed through a request session.

**Scope.** A place where a role can be granted. Every application has the global root scope. Tables can define more, such as an `organisation` scope keyed by `organisations.id` or a `project` scope keyed by `projects.id`, and a scope can have a parent. Rows _bind_ to a scope through a foreign key, so a project row belongs to its organisation and a metric row belongs to its device. A grant at a scope covers every row in that scope and every descendant scope, including rows created later.

```text
global
└── organisation: acme            organisation rows, memberships, locations
    ├── project: apollo           project row
    └── device: 1                 device row
        └── metrics rows          bound through metrics.device_id
```

**Table role.** A named bundle of one table's actions, with the scopes it may be granted at: "a project `reader` can `read`, and is granted per project".

**Shared role.** A role name, such as `admin` or `organisationAdmin`, that table roles opt into with `includedIn`. One shared grant then supplies every participating table's permissions. Shared roles have no permissions of their own; a table that does not opt in contributes nothing.

**Grant (assignment).** A stored row saying "this principal has this role at this scope", optionally between `startsAt` and `expiresAt`. Grants are additive: a principal can do anything any of their active grants allows.

### How a request is checked

When a request session runs `update projects ... where id = 'apollo'`, PostgreSQL asks, for each matching row:

1. Which action covers `update` on `projects`? (`write`)
2. Which table roles include `write`, and which shared roles include those table roles?
3. Does the principal hold an active grant for one of those roles at a scope this row belongs to, or at one of that scope's ancestors?

Rows that fail the check are invisible to reads and skipped by updates and deletes. An insert of a row the principal may not create fails with PostgreSQL's row-level security error. Every check runs inside the same database statement as the query, against current grants, so revoking a grant takes effect on the next statement.

### Two connections

The library needs two database connections:

- **`app`** logs in as a role that cannot bypass RLS: not a superuser, not `BYPASSRLS`, and not the owner of the protected tables. Request handlers use it through `secured.as(principal)`. The library refuses to run if this connection could bypass the policies.
- **`admin`** owns the tables. It applies migrations, creates and deletes rows during trusted provisioning, manages grants, and runs reports. Never hand it to request handlers.

### Designing access for a feature

Most access problems come down to the same questions:

1. **Who owns these rows?** Bind the table to that scope through its foreign key: an organisation, a project, a document, or a user.
2. **What can be done to them?** Name the actions: usually `read`, `write`, and `remove`, or narrower names such as `create` and `edit`.
3. **Who should be able to do it, and how widely?** Define table roles and the scopes they can be granted at.
4. **Should one grant cover several tables?** Opt the table roles into a shared role.
5. **When is the grant created, and when is it removed?** Write that into your provisioning and offboarding code; the library never infers grants from your data.

## Set up from scratch

This walkthrough protects organisations and their projects. It uses the same definitions as the runnable demo in [examples/](examples), which you can run with `npm run demo`.

### 1. Install

```sh
npm install @conservationtv/umbrella drizzle-orm
```

The library requires PostgreSQL 15 or newer and a Drizzle PostgreSQL driver that supports transactions.

### 2. Declare shared roles

Keep shared roles in their own module and import them wherever a table participates. A shared role's name is its stored identity, so treat it like a column name.

```ts
// roles.ts
import { role } from '@conservationtv/umbrella';

export const admin = role('admin', {
  label: 'Administrator',
  description: 'Manage participating resources.'
});

export const reader = role('reader', {
  label: 'Reader',
  description: 'Read participating resources.'
});

export const organisationAdmin = role('organisationAdmin', {
  label: 'Organisation administrator',
  description: 'Manage an organisation and everything it owns.',
  assignableScopes: ['organisation']
});
```

`role(name)` can be granted at the global scope by default. `assignableScopes` replaces that default: `organisationAdmin` above can only be granted for a particular organisation. Use `['global', 'organisation']` to allow both.

### 3. Describe access beside each table

```ts
// schema.ts
import { pgTable, text } from 'drizzle-orm/pg-core';
import { resourceScope, roleAssignments, withAccess } from '@conservationtv/umbrella';
import { admin, organisationAdmin, reader } from './roles.js';

export { roleAssignments };

export const users = pgTable('users', { id: text().primaryKey(), name: text().notNull() });

export const organisations = withAccess(
  pgTable('organisations', { id: text().primaryKey(), name: text().notNull() }),
  t => ({
    name: 'organisations',
    scope: resourceScope({ name: 'organisation', key: t.id }),
    actions: { read: ['select'], write: ['update'] },
    roles: {
      admin: {
        permissions: ['read', 'write'],
        assignableScopes: ['organisation'],
        includedIn: [admin, organisationAdmin]
      }
    }
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
      reader: {
        label: 'Project reader',
        permissions: ['read'],
        assignableScopes: ['project'],
        includedIn: [reader]
      },
      admin: {
        permissions: ['read', 'write', 'remove'],
        assignableScopes: ['project'],
        includedIn: [admin, organisationAdmin]
      }
    }
  })
);
```

What this says:

- `organisations` defines the `organisation` scope. Its `admin` role can read and rename an organisation.
- `projects` defines the `project` scope, whose parent is the project's organisation. A grant at Acme therefore reaches every Acme project.
- The project `reader` role can be granted for a single project, and also contributes to shared `reader`.
- Both tables' `admin` roles contribute to shared `admin` and `organisationAdmin`. Granting `organisationAdmin` at Acme lets someone rename Acme and manage its projects. Granting shared `admin` at the global scope does the same everywhere.
- `users` is an ordinary table. Unprotected tables are unaffected by the library.

A few rules keep definitions safe:

- `name` and scope names are stored in grants. Changing one requires migrating existing grants.
- Scope keys must be single-column primary or unique keys. Scope links must be non-null foreign keys.
- Scope keys and links cannot be changed by request sessions, so rows cannot be moved into a scope the principal controls. List further columns in `immutable: [t.column]` to lock them too.
- A table with a scope but no actions is locked: request sessions can neither read nor write it.
- Mismatches, such as a role granted at a scope its table cannot reach, are rejected by TypeScript and again at runtime.

To bind a table to an existing scope without defining a new one, use `.via` directly:

```ts
scope: organisations.$access.scope.via(t.organisationId);
```

### 4. Create the grants table

Export `roleAssignments` from the schema your migration tool reads, as above, so `drizzle-kit generate` creates the `authz_role_assignments` table. If you do not use Drizzle Kit, apply [migrations/0000_authz.sql](migrations/0000_authz.sql) instead.

### 5. Generate the access policies

Your access definitions compile to PostgreSQL row-level security: RLS enabled on each protected table, plus its policies, helper functions, and immutability triggers. Drizzle Kit cannot generate functions or triggers, so the package includes a command that adds them as a Drizzle Kit custom migration. Run it after `drizzle-kit generate`:

```json
{
  "scripts": {
    "db:generate": "drizzle-kit generate && umbrella generate"
  }
}
```

`umbrella generate` reads `schema` and `out` from your `drizzle.config.ts`, loads the schema, and compares the compiled policies with the latest ones it generated. If they differ, it runs `drizzle-kit generate --custom --name=access_policies` and fills in that file. If not, it writes nothing, so running it on every generate is safe. `drizzle-kit migrate`, or Drizzle's `migrate()` function, then applies it in order with your other migrations.

Each access-policy migration is a complete snapshot rather than a diff. It first drops every policy, trigger, and helper function an earlier one created, then recreates them from the current definitions, so applying any sequence of them leaves exactly the latest rules. Drizzle applies pending migrations in a single transaction, so a database several versions behind never commits with half-updated policies. A table you stop protecting keeps RLS enabled with no policies, which denies the application role all access to it, until you disable RLS in a migration of your own.

The command needs Node 22.18 or newer. It loads TypeScript through [tsx](https://tsx.is) when your project has it installed, and otherwise through Node's built-in type stripping.

#### Changing a scope key or link column

PostgreSQL refuses to change the type of, or drop, a column that a policy uses: scope keys and the foreign keys that bind rows to scopes. Before running `drizzle-kit generate` for such a change, generate a migration that drops the policies:

```sh
npx @conservationtv/umbrella generate --before
npx drizzle-kit generate
npx @conservationtv/umbrella generate
```

The three migrations are applied in that order and in one transaction, so the tables are never left unprotected. Renaming a column needs no extra step: PostgreSQL updates the policies, and the next access-policy migration rebuilds the helper functions.

#### Without Drizzle Kit

`rlsMigration(schema)` returns the same SQL as a string, and `rlsTeardownMigration()` returns the drop-only version. Apply them as the tables' owner after the tables exist, using whichever migration tool you prefer. Statements are separated by Drizzle's `--> statement-breakpoint` marker, which other tools treat as a comment.

### 6. Create the application's database role

Create a login role for request traffic and give it only the privileges your protected queries need. The policies decide which rows; ordinary privileges decide which tables and columns.

```sql
create role app login password '...';
grant usage on schema public to app;
grant select, update on organisations to app;
grant select, insert, update, delete on projects to app;
grant usage on all sequences in schema public to app;
```

Do not grant `app` access to `authz_role_assignments`; the generated policies read it on the principal's behalf. Do not make `app` a member of the role that owns the tables.

### 7. Create the authorization client

```ts
// access.ts
import { drizzle } from 'drizzle-orm/node-postgres';
import { defineAuthorization, withAuthorization } from '@conservationtv/umbrella';
import * as schema from './schema.js';
import { admin, reader, organisationAdmin } from './roles.js';

export const appDb = drizzle(process.env.APP_DATABASE_URL!);
export const adminDb = drizzle(process.env.ADMIN_DATABASE_URL!);

/** The compiled definitions. Request handlers call `authorization.as(appDb, principal)`; trusted code calls
 * `authorization.access(adminDb)`. */
export const authorization = defineAuthorization({ schema, roles: { admin, reader, organisationAdmin } });

/** The same, with both connections bound up front; the rest of this guide uses it for brevity. */
export const secured = withAuthorization({ app: appDb, admin: adminDb }, { schema, roles: { admin, reader, organisationAdmin } });
```

Table roles, and shared roles that tables include, are discovered from `schema`. The optional `roles` registry also lists shared roles in the catalog before any table includes them. `defineAuthorization` compiles and validates the definitions once, so call it at module scope; on platforms that open a connection per request, supply that connection to `as()` or `access()` when the request runs. Most requests only ever need `as()` and the application connection.

### 8. Create rows and grant roles

Grants are created through `secured.access` by trusted code: sign-up, invitation acceptance, an admin screen whose callers you have authorized, or a seed script. The scope row must already exist.

```ts
import { user } from '@conservationtv/umbrella';

await adminDb.insert(organisations).values({ id: 'acme', name: 'Acme' });
await adminDb.insert(projects).values({ id: 'apollo', organisationId: 'acme', name: 'Apollo' });

await secured.access.at(organisations.$access.scope.at('acme')).grant({
  principal: user('alice'),
  role: organisationAdmin
});

await secured.access.at(projects.$access.scope.at('apollo')).grant({
  principal: user('bob'),
  role: projects.$access.roles.reader
});
```

`$access.scope` describes a scope type; `.at('acme')` selects one scope. `secured.access.root()` grants at the global scope. Granting the same role to the same principal at the same scope and time window again returns the existing grant.

### 9. Query on behalf of a request

Give handlers a session for the authenticated principal and run queries inside its `transaction`. The principal is attached to that transaction only.

```ts
import { eq } from 'drizzle-orm';

const session = secured.as(ctx.principal);

const visibleProjects = await session.transaction(tx => tx.select().from(projects));

const renamed = await session.transaction(tx =>
  tx.update(projects).set({ name: 'Apollo 2' }).where(eq(projects.id, 'apollo')).returning()
);
```

Alice sees and can rename every Acme project. Bob sees Apollo, but his update returns no rows because his role only reads. Anyone else sees nothing. Inside the transaction, any Drizzle query works: joins, aggregates, relational queries, and raw SQL all run under the same policies, with each table contributing only the rows the principal may see.

Expect these outcomes:

- Reads, counts, and joins quietly exclude rows the principal cannot read.
- Updates and deletes affect only permitted rows. An empty result can mean "no match" or "no access".
- An insert the principal cannot perform fails with PostgreSQL's row-level security error (SQLSTATE `42501`) and rolls back its transaction. Changing an immutable column fails the same way.

## Solve common access problems

The recipes below extend the walkthrough's model to a fuller application with users, organisations, memberships, projects, devices, metrics, and locations:

- `users` has a text primary key `id` and a `name`.
- `organisations` defines the `organisation` scope.
- `organisationUsers` links users to organisations with a composite primary key, and binds to the organisation scope through `organisationId`.
- `projects` and `devices` define `project` and `device` scopes with the organisation as their parent.
- `metrics` binds to the device scope through `deviceId`.
- `locations` binds directly to the organisation scope through `organisationId`.

For projects, devices, metrics, and locations, `read` covers `select`, `write` covers `insert` and `update`, and `remove` covers `delete`. [examples/schema.ts](examples/schema.ts) contains the complete definitions.

The examples use the same people throughout: Alice administers Acme, Bob is an Acme member, and Cara has no Acme access. `aliceSession`, `bobSession`, and `caraSession` are `secured.as(user('alice'))` and so on. Each recipe lists the tables and grants it adds; register every new table in `schema` and generate a new access-policy migration.

| Problem                                               | Recipe                                                                                                            |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Staff need access to everything                       | [Global administrators and readers](#global-administrators-and-readers)                                           |
| Customers administer their own organisation           | [Organisation administrators](#organisation-administrators)                                                       |
| Someone needs one record and nothing else             | [Access to a single resource](#access-to-a-single-resource)                                                       |
| Every signed-in account reads shared data             | [Shared reference data for signed-in accounts](#shared-reference-data-for-signed-in-accounts)                     |
| People manage their own account                       | [Let people manage their own data](#let-people-manage-their-own-data)                                             |
| Members see each other, but not private account data  | [A member directory without exposing private accounts](#a-member-directory-without-exposing-private-accounts)     |
| Participants contribute; authors edit their own posts | [Comments with participant, author, and moderator access](#comments-with-participant-author-and-moderator-access) |
| Shared membership fields plus private settings        | [Membership records with private preferences](#membership-records-with-private-preferences)                       |
| Devices or services write data                        | [Machines and services as principals](#machines-and-services-as-principals)                                       |
| Access should start or end at a set time              | [Temporary access](#temporary-access)                                                                             |
| Some fields only trusted code may change              | [Fields only trusted code may change](#fields-only-trusted-code-may-change)                                       |
| Someone leaves                                        | [Remove access](#remove-access)                                                                                   |

### Global administrators and readers

**Problem:** support staff should read everything, and operators should manage everything, without a grant per organisation.

Opt each table's roles into shared `admin` and `reader`, as the walkthrough does, and grant them at the global scope:

```ts
await secured.access.root().grant({ principal: user('sam'), role: reader });
await secured.access.root().grant({ principal: user('olivia'), role: admin });
```

Sam can read every table whose reader role includes shared `reader`; Olivia can do everything participating admin roles allow. When a new table later opts into `admin`, existing admins receive its permissions once the updated definitions are deployed, with no new grants.

Only tables that opt in contribute. A table that never lists `admin` in `includedIn` stays out of reach, which is how you keep especially sensitive tables away from broad roles.

### Organisation administrators

**Problem:** each customer organisation has administrators who manage that organisation and everything it owns, and nothing else.

Declare `organisationAdmin` with `assignableScopes: ['organisation']` and opt the organisation's tables into it. In the example application it supplies:

- `organisations`: read and update the organisation.
- `organisationUsers`: list, add, and remove memberships.
- `projects`, `devices`, `locations`, and `metrics`: read, create, update, and delete organisation-owned rows.

Memberships and locations bind directly through `organisationId`. Projects and devices have the organisation as their parent, and metrics inherit through their device. One grant covers all of them:

```ts
await secured.access.at(organisations.$access.scope.at('acme')).grant({
  principal: user('alice'),
  role: organisationAdmin
});

await aliceSession.transaction(async tx => {
  await tx.update(organisations).set({ name: 'Acme Ltd' }).where(eq(organisations.id, 'acme'));
  await tx.insert(organisationUsers).values({ organisationId: 'acme', userId: 'bob' });
  await tx.insert(projects).values({ id: 'atlas', organisationId: 'acme', name: 'Atlas' });
  await tx.insert(devices).values({ id: 3, organisationId: 'acme', name: 'Lab sensor' });
  await tx.insert(locations).values({ organisationId: 'acme', name: 'Lab' });
  await tx.insert(metrics).values({ deviceId: 3, value: 42 });
});
```

To make Alice an administrator of Globex too, grant the role again at Globex. Each grant is independent; revoking Globex leaves Acme intact.

Things to keep in mind:

- A membership row grants nothing by itself, and administration does not require membership. Grant roles alongside membership in your invitation and removal code.
- Removing a membership does not revoke independently granted roles.
- Organisation creation and deletion, and granting roles, remain trusted operations.
- If a shared role should be grantable both globally and per organisation, use `assignableScopes: ['global', 'organisation']`. Every table that opts in must be able to reach each of those scopes.
- Membership reads return user IDs. For names and avatars, see [A member directory without exposing private accounts](#a-member-directory-without-exposing-private-accounts).

### Access to a single resource

**Problem:** Bob should read the Apollo project, but no other project in Acme.

Grant a table role at the narrower scope:

```ts
await secured.access.at(projects.$access.scope.at('apollo')).grant({
  principal: user('bob'),
  role: projects.$access.roles.reader
});

const bobProjects = await bobSession.transaction(tx => tx.select().from(projects)); // Apollo only
```

A table role's `assignableScopes` decides how narrowly it can be granted: the project reader role lists `['project']`, so it is granted per project. Child tables bound to the project scope, such as tasks with a `projectId` foreign key, can offer their own project-scoped roles, or opt into a shared role assignable at `project`, so that one grant covers the project and everything inside it.

### Shared reference data for signed-in accounts

**Problem:** currencies are shared across organisations. Every account should read them, and only designated maintainers should change them.

Declare two global shared roles:

```ts
// roles.ts
export const signedIn = role('signedIn');
export const referenceDataMaintainer = role('referenceDataMaintainer');
```

A table without `scope` or `scopes` is global:

```ts
// reference-schema.ts
import { pgTable, text } from 'drizzle-orm/pg-core';
import { withAccess } from '@conservationtv/umbrella';
import { signedIn, referenceDataMaintainer } from './roles.js';

export const currencies = withAccess(
  pgTable('currencies', {
    code: text().primaryKey(),
    name: text().notNull()
  }),
  t => ({
    name: 'currencies',
    immutable: [t.code],
    actions: { read: ['select'], maintain: ['insert', 'update', 'delete'] },
    roles: {
      reader: {
        permissions: ['read'],
        assignableScopes: ['global'],
        includedIn: [signedIn]
      },
      maintainer: {
        permissions: ['read', 'maintain'],
        assignableScopes: ['global'],
        includedIn: [referenceDataMaintainer]
      }
    }
  })
);
```

Seed GBP, EUR, and USD through trusted code. When you provision an account, grant it `signedIn`. The role name does not detect authentication: an account only has it once you grant it.

```ts
await secured.access.root().grant({ principal: user('bob'), role: signedIn });
await secured.access.root().grant({ principal: user('cara'), role: signedIn });
await secured.access.root().grant({ principal: user('alice'), role: referenceDataMaintainer });

const availableCurrencies = await bobSession.transaction(tx => tx.select().from(currencies).orderBy(currencies.code)); // EUR, GBP, USD

const bobChanges = await bobSession.transaction(tx =>
  tx
    .update(currencies)
    .set({ name: 'Changed by Bob' })
    .where(eq(currencies.code, 'GBP'))
    .returning({ code: currencies.code })
); // []

const aliceChanges = await aliceSession.transaction(tx =>
  tx
    .update(currencies)
    .set({ name: 'Pound sterling' })
    .where(eq(currencies.code, 'GBP'))
    .returning({ code: currencies.code })
); // [{ code: 'GBP' }]
```

Bob and Cara read the same currencies regardless of their memberships. Alice's organisation administrator grant supplies no currency permissions; her maintainer grant does. Codes cannot change through request sessions, and ordinary foreign keys can prevent deleting currencies in use.

Countries and other reference tables can opt into the same roles. `signedIn` only reaches tables that include it, so it never makes accounts, documents, or other tables globally readable.

### Let people manage their own data

**Problem:** each person should read and edit their own account, and every other row that belongs to them, from a single grant made when the account is created.

Give the users table a `user` scope and declare a shared role assignable at it. The name `self` is only a name; what makes it "self" is that trusted code grants Alice the role at Alice's own user scope.

```ts
// roles.ts
export const self = role('self', {
  assignableScopes: ['user']
});
```

Never grant `self` at the global scope: that would give the principal every participating table's owner permissions on every row.

If your authentication library generates the users table (Better Auth, for example), wrap it in a separate module so regeneration does not overwrite the access definition. Assuming the generated table is imported as `authUser`:

```ts
export const users = withAccess(authUser, t => ({
  name: 'users',
  scope: resourceScope({ name: 'user', key: t.id }),
  actions: {
    read: ['select'],
    edit: ['update']
  },
  roles: {
    accountOwner: {
      permissions: ['read', 'edit'],
      assignableScopes: ['user'],
      includedIn: [self]
    }
  }
}));
```

After the account row is committed, grant the role once:

```ts
await secured.access.at(users.$access.scope.at('alice')).grant({
  principal: user('alice'),
  role: self
});
```

Any table that binds to the user scope and opts an owner role into `self` is covered by this grant, including rows created later; the following recipes rely on it. The principal and the scope are separate inputs, so provisioning code must grant Alice the role at Alice's scope, not someone else's. Retrying the grant is safe.

Row permissions still need table privileges: let the `app` role update only the account columns your application owns. Keep the authentication library's session, credential, and verification tables inaccessible to `app`; the authentication library keeps using its own trusted connection.

### A member directory without exposing private accounts

**Problem:** members of Acme should see each other's names and avatars, but nobody should read another person's private account (email, verification status), and each person should edit their own directory entry.

Keep the user account private and store directory information in one profile per user per organisation. Alice can have an Acme profile and a Globex profile that both reference the same account. A foreign key to `users` does not grant read access to the account.

Declare a role for ordinary members:

```ts
// roles.ts
export const organisationMember = role('organisationMember', {
  assignableScopes: ['organisation']
});
```

Define the profile table with a non-null primary key `id`, non-null foreign keys `organisationId` and `userId`, a unique constraint on `(organisationId, userId)`, and directory fields such as `name` and `image`. Assuming it is exported as `profileTable`, give it two scope bindings: its own profile scope, whose parent is the organisation, and the owner's user scope.

```ts
export const profiles = withAccess(profileTable, t => ({
  name: 'profiles',
  scopes: {
    profile: resourceScope({
      name: 'profile',
      key: t.id,
      parent: organisations.$access.scope.via(t.organisationId)
    }),
    account: users.$access.scope.via(t.userId)
  },
  actions: {
    read: ['select'],
    edit: ['update']
  },
  roles: {
    owner: {
      permissions: ['read', 'edit'],
      assignableScopes: ['user'],
      includedIn: [self]
    },
    reader: {
      permissions: ['read'],
      assignableScopes: ['organisation'],
      includedIn: [organisationMember]
    },
    admin: {
      permissions: ['read', 'edit'],
      assignableScopes: ['organisation'],
      includedIn: [organisationAdmin]
    }
  }
}));
```

With named `scopes`, access through any binding is enough. Organisation roles reach profiles through the organisation parent; Alice's `self` grant reaches profiles whose `userId` is hers. Neither path makes anyone else's account readable. Scope keys, the organisation link, and `userId` are all immutable through request sessions.

When Alice joins Acme, trusted code creates her membership and profile, then grants the organisation roles:

```ts
await secured.access.at(organisations.$access.scope.at('acme')).grant({
  principal: user('alice'),
  role: organisationMember
});

// If Alice should administer Acme, grant its administrator role too.
await secured.access.at(organisations.$access.scope.at('acme')).grant({
  principal: user('alice'),
  role: organisationAdmin
});

const members = await aliceSession.transaction(tx =>
  tx
    .select({ userId: profiles.userId, name: profiles.name, image: profiles.image })
    .from(profiles)
    .where(eq(profiles.organisationId, 'acme'))
);
```

The member grant lets Alice read all Acme profiles, the administrator grant lets her edit them, and her `self` grant lets her edit only her own profiles in any organisation. These definitions have no insert or delete action, so creating and removing profiles stays with trusted membership code.

If you do not use a `self` role, give the table a single `scope` and a profile-scoped owner role (`assignableScopes: ['profile']`), and grant it to each user at their own profile when the profile is created.

Design notes:

- Profiles are organisation-specific: changing Alice's Acme name does not change her Globex name. If the account also stores a name and image, decide which values are defaults and which are per-organisation overrides.
- If every membership has a profile, the profile row can itself represent membership; see [Membership records with private preferences](#membership-records-with-private-preferences). The directory lists every member only when every member has a profile.
- Revoking Alice's organisation grants does not stop her `self` grant reaching her Acme profile. Delete the profile when membership ends if former members should lose it; a "disabled" flag alone does not affect the policies.
- When an account is deleted, delete its profiles and its `self` grant too, so a reused user ID cannot inherit them.

### Comments with participant, author, and moderator access

**Problem:** Acme owns a handbook. Bob should read it, read its comments, and add comments, while editing or deleting only his own. Alice should moderate all Acme contributions. Cara should see nothing.

This combines three sources of access on the same rows: the document (participants), the author (`self`), and the organisation (moderators). Declare a document-scoped shared role:

```ts
// roles.ts
export const documentParticipant = role('documentParticipant', {
  assignableScopes: ['document']
});
```

Define a document scope with the organisation as its parent. Comments and attachments bind to both the document and their author's user scope:

```ts
// contributions-schema.ts
import { pgTable, text } from 'drizzle-orm/pg-core';
import { resourceScope, withAccess } from '@conservationtv/umbrella';
import { users, organisations } from './identity-schema.js';
import { documentParticipant, organisationAdmin, self } from './roles.js';

export const documents = withAccess(
  pgTable('documents', {
    id: text().primaryKey(),
    organisationId: text('organisation_id')
      .notNull()
      .references(() => organisations.id),
    title: text().notNull()
  }),
  t => ({
    name: 'documents',
    scope: resourceScope({
      name: 'document',
      key: t.id,
      parent: organisations.$access.scope.via(t.organisationId)
    }),
    actions: { read: ['select'], edit: ['update'] },
    roles: {
      participant: {
        permissions: ['read'],
        assignableScopes: ['document'],
        includedIn: [documentParticipant]
      },
      administrator: {
        permissions: ['read', 'edit'],
        assignableScopes: ['organisation'],
        includedIn: [organisationAdmin]
      }
    }
  })
);

const contributionActions = {
  read: ['select'],
  create: ['insert'],
  edit: ['update'],
  remove: ['delete']
} as const;

const contributionRoles = {
  participant: {
    permissions: ['read', 'create'],
    assignableScopes: ['document'],
    includedIn: [documentParticipant]
  },
  author: {
    permissions: ['read', 'edit', 'remove'],
    assignableScopes: ['user'],
    includedIn: [self]
  },
  moderator: {
    permissions: ['read', 'edit', 'remove'],
    assignableScopes: ['organisation'],
    includedIn: [organisationAdmin]
  }
} as const;

export const comments = withAccess(
  pgTable('comments', {
    id: text().primaryKey(),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id),
    authorId: text('author_id')
      .notNull()
      .references(() => users.id),
    body: text().notNull()
  }),
  t => ({
    name: 'comments',
    scopes: {
      document: documents.$access.scope.via(t.documentId),
      author: users.$access.scope.via(t.authorId)
    },
    immutable: [t.id],
    actions: contributionActions,
    roles: contributionRoles
  })
);

export const attachments = withAccess(
  pgTable('attachments', {
    id: text().primaryKey(),
    documentId: text('document_id')
      .notNull()
      .references(() => documents.id),
    uploadedByUserId: text('uploaded_by_user_id')
      .notNull()
      .references(() => users.id),
    objectKey: text('object_key').notNull(),
    label: text().notNull()
  }),
  t => ({
    name: 'attachments',
    scopes: {
      document: documents.$access.scope.via(t.documentId),
      uploader: users.$access.scope.via(t.uploadedByUserId)
    },
    immutable: [t.id, t.objectKey],
    actions: contributionActions,
    roles: contributionRoles
  })
);
```

The shared action and role objects give both tables identical rules; on attachments, the `author` role reaches rows through `uploadedByUserId`.

Trusted provisioning creates the `handbook` document and an existing `alice-comment`. Bob already has his `self` grant; add his handbook participation and Alice's administration:

```ts
await secured.access.at(documents.$access.scope.at('handbook')).grant({
  principal: user('bob'),
  role: documentParticipant
});
await secured.access.at(organisations.$access.scope.at('acme')).grant({
  principal: user('alice'),
  role: organisationAdmin
});

await bobSession.transaction(tx =>
  tx.insert(comments).values({
    id: 'bob-comment',
    documentId: 'handbook',
    authorId: 'bob',
    body: 'Could we clarify the holiday policy?'
  })
);

const editedOwnComment = await bobSession.transaction(tx =>
  tx
    .update(comments)
    .set({ body: 'Updated question.' })
    .where(eq(comments.id, 'bob-comment'))
    .returning({ id: comments.id })
); // [{ id: 'bob-comment' }]

const editedAliceComment = await bobSession.transaction(tx =>
  tx
    .update(comments)
    .set({ body: 'Changed by Bob.' })
    .where(eq(comments.id, 'alice-comment'))
    .returning({ id: comments.id })
); // []

const caraComments = await caraSession.transaction(tx =>
  tx.select().from(comments).where(eq(comments.documentId, 'handbook'))
); // []
```

Participation lets Bob create comments through the document binding; his `self` grant lets him edit and delete them through the author binding. Alice moderates every Acme contribution through the document's organisation parent, but moderation alone does not let her create contributions. No grant per comment or attachment is needed.

Points to handle in your handlers:

- Set `authorId` or `uploadedByUserId` from the authenticated principal and accept only content fields from the request. The policy checks that the principal can create comments on the document, not that the author ID is theirs.
- The upload service chooses the storage key, which is then immutable. Authorize a download by reading the attachment row through the request session before fetching from storage.
- Author access does not depend on participation: if Bob's participation is revoked, he can still read, edit, and delete his own contributions.
- Joining comments to users applies the users table's policies, so a readable comment does not expose its author's private account. Use profiles for author names and avatars.

### Membership records with private preferences

**Problem:** every member has exactly one directory entry with the same lifecycle as their membership, plus private per-membership settings that even administrators should not read.

Combine membership and directory fields in one row, and put private settings in a separate table that only the owner's `self` role reaches. This replaces the separate membership and profile tables above.

```ts
// membership-schema.ts
import { boolean, foreignKey, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { resourceScope, withAccess } from '@conservationtv/umbrella';
import { users, organisations } from './identity-schema.js';
import { organisationMember, organisationAdmin, self } from './roles.js';

export const memberships = withAccess(
  pgTable(
    'memberships',
    {
      id: text().primaryKey(),
      organisationId: text('organisation_id')
        .notNull()
        .references(() => organisations.id),
      userId: text('user_id')
        .notNull()
        .references(() => users.id),
      displayName: text('display_name').notNull(),
      image: text(),
      jobTitle: text('job_title'),
      status: text().notNull().default('active'),
      joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow()
    },
    t => [
      unique('memberships_organisation_user').on(t.organisationId, t.userId),
      unique('memberships_id_user').on(t.id, t.userId)
    ]
  ),
  t => ({
    name: 'memberships',
    scopes: {
      membership: resourceScope({
        name: 'membership',
        key: t.id,
        parent: organisations.$access.scope.via(t.organisationId)
      }),
      account: users.$access.scope.via(t.userId)
    },
    immutable: [t.status, t.joinedAt],
    actions: { read: ['select'], edit: ['update'] },
    roles: {
      directoryReader: {
        permissions: ['read'],
        assignableScopes: ['organisation'],
        includedIn: [organisationMember]
      },
      owner: {
        permissions: ['read', 'edit'],
        assignableScopes: ['user'],
        includedIn: [self]
      },
      administrator: {
        permissions: ['read', 'edit'],
        assignableScopes: ['organisation'],
        includedIn: [organisationAdmin]
      }
    }
  })
);

export const membershipPreferences = withAccess(
  pgTable(
    'membership_preferences',
    {
      membershipId: text('membership_id').primaryKey(),
      userId: text('user_id')
        .notNull()
        .references(() => users.id),
      emailDigest: boolean('email_digest').notNull().default(true)
    },
    t => [
      foreignKey({
        columns: [t.membershipId, t.userId],
        foreignColumns: [memberships.id, memberships.userId]
      }).onDelete('cascade')
    ]
  ),
  t => ({
    name: 'membershipPreferences',
    scope: users.$access.scope.via(t.userId),
    immutable: [t.membershipId],
    actions: { read: ['select'], edit: ['update'] },
    roles: {
      owner: {
        permissions: ['read', 'edit'],
        assignableScopes: ['user'],
        includedIn: [self]
      }
    }
  })
);
```

The first unique constraint prevents duplicate memberships. The second lets the preferences foreign key check that the preference's user actually owns the membership, which matters because access to preferences comes from `userId`. Deleting a membership cascades to its preferences.

Trusted provisioning creates `bob-acme`, `alice-acme`, and their preferences. Bob's existing `self` grant already reaches both his membership and his preferences. Give him directory access at Acme:

```ts
await secured.access.at(organisations.$access.scope.at('acme')).grant({
  principal: user('bob'),
  role: organisationMember
});

const directory = await bobSession.transaction(tx =>
  tx
    .select({
      userId: memberships.userId,
      name: memberships.displayName,
      image: memberships.image,
      jobTitle: memberships.jobTitle
    })
    .from(memberships)
    .where(eq(memberships.organisationId, 'acme'))
);

const ownProfile = await bobSession.transaction(tx =>
  tx
    .update(memberships)
    .set({ displayName: 'Robert', jobTitle: 'Engineer' })
    .where(eq(memberships.id, 'bob-acme'))
    .returning({ id: memberships.id })
); // [{ id: 'bob-acme' }]

const aliceProfile = await bobSession.transaction(tx =>
  tx
    .update(memberships)
    .set({ displayName: 'Changed by Bob' })
    .where(eq(memberships.id, 'alice-acme'))
    .returning({ id: memberships.id })
); // []

const digestPreference = await bobSession.transaction(tx =>
  tx
    .update(membershipPreferences)
    .set({ emailDigest: false })
    .where(eq(membershipPreferences.membershipId, 'bob-acme'))
    .returning({ membershipId: membershipPreferences.membershipId })
); // [{ membershipId: 'bob-acme' }]

const alicePreferences = await bobSession.transaction(tx =>
  tx.select().from(membershipPreferences).where(eq(membershipPreferences.membershipId, 'alice-acme'))
); // []
```

Bob lists the Acme directory and edits only his own entry and preferences. Alice, as administrator, can edit members' directory fields but cannot read their preferences. Cara cannot list Acme memberships.

`status` and `joinedAt` are immutable for every request session, administrators included. Trusted membership code changes them and creates or removes rows. Setting `status` to `inactive` does not remove visibility or revoke grants by itself; your membership code must do that too.

### Machines and services as principals

**Problem:** each sensor should write metrics for itself and no other device. A background service should read metrics for reporting.

Principals are not limited to users. Grant a device a role at its own device scope:

```ts
import { device, principal } from '@conservationtv/umbrella';

const sensor = device(1);
await secured.access.at(devices.$access.scope.at(sensor.id)).grant({
  principal: sensor,
  role: metrics.$access.roles.writer
});

await secured.as(sensor).transaction(tx => tx.insert(metrics).values({ deviceId: 1, value: 42 }));
// Inserting { deviceId: 2 } fails with a row-level security error.

const reporting = principal('service', 'reporting');
await secured.access.root().grant({ principal: reporting, role: metrics.$access.roles.reader });
```

Authenticate the device or service before creating its session, for example with a signed request or an API key. `user('1')` and `device(1)` are different principals; IDs are compared as text within a kind, so `device(1)` and `device('1')` are the same.

### Temporary access

**Problem:** a contractor should read Apollo during November only.

Give the grant a time window. `startsAt` is inclusive and `expiresAt` is exclusive; either can be omitted.

```ts
await secured.access.at(projects.$access.scope.at('apollo')).grant({
  principal: user('cara'),
  role: projects.$access.roles.reader,
  startsAt: new Date('2026-11-01T00:00:00Z'),
  expiresAt: new Date('2026-12-01T00:00:00Z')
});
```

Policies compare windows with the database's statement time, so access starts and stops without a job. Pending and expired grants remain stored and visible in reports. Each different window is a separate grant: to change a window, grant the new one and revoke the old. Delete expired grants periodically if you do not need them for auditing.

### Fields only trusted code may change

**Problem:** a member can edit their display name, but only billing code may change the organisation's plan.

Roles grant row-level actions; they do not distinguish columns within one update. Choose one of:

- **Mark the column immutable.** `immutable: [t.plan]` stops every request session from changing it, administrators included. Change it from trusted code using the admin connection.
- **Restrict the column privilege.** Grant `app` `update (name)` on the table rather than `update`, so request sessions cannot write `plan` at all.
- **Split the table.** Move administrator-only fields to a separate table with its own roles, as preferences are separated from the directory above.

Scope keys and scope links are always immutable for request sessions, so a row can never be moved into a scope the principal controls.

### Remove access

**Problem:** Bob leaves Acme.

Grants exist independently of your data, so offboarding needs to remove both:

```ts
const acme = organisations.$access.scope.at('acme');

await secured.access.at(acme).revoke({ principal: user('bob'), role: organisationMember });
await secured.access.at(acme).revoke({ principal: user('bob'), role: organisationAdmin });
await adminDb.delete(memberships).where(eq(memberships.id, 'bob-acme'));
```

Revoking by principal and role removes every matching grant at that scope, whatever its window; `secured.access.revoke(id)` removes one grant. Grants at other scopes, and grants of other roles, are unaffected. Then delete or detach any rows that still reach Bob through his `self` grant, such as his Acme profile.

When you delete a scope row, such as a project or organisation, delete grants at that scope in the same trusted operation, and do not reuse its ID while old grants remain. Find them with `grantsQuery({ scope })`, below.

## Administer and report on access

These APIs live on `secured.access` and use the admin connection. Expose their results only through endpoints whose callers you have authorized.

The examples use the [example application](#solve-common-access-problems), where Acme owns the Apollo and Atlas projects and Globex owns Gemini. A principal can hold any number of grants: different roles, the same role at different scopes, or the same role with different time windows. The example grants include each case:

| User  | Role                            | Granted at          | Window                      |
| ----- | ------------------------------- | ------------------- | --------------------------- |
| Alice | shared `admin`                  | global              | always                      |
| Bob   | `projects.$access.roles.reader` | project Apollo      | always                      |
| Bob   | shared `organisationAdmin`      | organisation Globex | always                      |
| Dana  | shared `organisationAdmin`      | organisation Acme   | always                      |
| Erin  | `projects.$access.roles.reader` | project Gemini      | always                      |
| Erin  | `projects.$access.roles.reader` | project Atlas       | September 2026, now expired |
| Cara  | none                            |                     |                             |

The results shown were produced by running each query against that data on 12 October 2026. Grant IDs are UUIDs and are shortened here.

```ts
import { and, arrayContains, eq, inArray, or, sql } from 'drizzle-orm';
import { user } from '@conservationtv/umbrella';

const acme = organisations.$access.scope.at('acme');
const apollo = projects.$access.scope.at('apollo');
```

### Read the catalog

`catalog()` describes every role from the loaded definitions, without a database query:

```ts
const catalog = secured.access.catalog();

const projectResource = catalog.resources.find(resource => resource.name === 'projects')!;
```

A resource lists the scopes its rows can be reached from, its actions, and its table roles:

```ts
// projectResource
{
  name: 'projects',
  scopes: ['project', 'organisation', 'global'],
  actions: [
    { name: 'read', operations: ['select'] },
    { name: 'write', operations: ['insert', 'update'] },
    { name: 'remove', operations: ['delete'] }
  ],
  roles: [
    {
      id: 'projects/reader',
      resource: 'projects',
      name: 'reader',
      roleKind: 'table',
      label: 'Project reader',
      description: 'Read this project.',
      permissions: ['read'],
      assignableScopes: ['project'],
      includedIn: ['@shared/reader'],
      includes: []
    },
    {
      id: 'projects/admin',
      resource: 'projects',
      name: 'admin',
      roleKind: 'table',
      label: 'admin',
      description: null,
      permissions: ['read', 'write', 'remove'],
      assignableScopes: ['project'],
      includedIn: ['@shared/admin', '@shared/organisationAdmin'],
      includes: []
    }
  ]
}
```

A shared role has no permissions of its own. Its `includes` lists what each participating table contributes:

```ts
catalog.sharedRoles.find(role => role.name === 'organisationAdmin');
// {
//   id: '@shared/organisationAdmin',
//   resource: '@shared',
//   name: 'organisationAdmin',
//   roleKind: 'shared',
//   label: 'Organisation administrator',
//   description: 'Manage an organisation, its memberships, projects, devices, locations, and metrics.',
//   permissions: [],
//   assignableScopes: ['organisation'],
//   includedIn: [],
//   includes: [
//     { roleId: 'devices/admin', resource: 'devices', role: 'admin', permissions: ['read', 'write', 'remove'] },
//     { roleId: 'locations/admin', resource: 'locations', role: 'admin', permissions: ['read', 'write', 'remove'] },
//     { roleId: 'metrics/maintainer', resource: 'metrics', role: 'maintainer', permissions: ['read', 'write', 'remove'] },
//     { roleId: 'organisationUsers/admin', resource: 'organisationUsers', role: 'admin', permissions: ['listUsers', 'addUsers', 'removeUsers'] },
//     { roleId: 'organisations/admin', resource: 'organisations', role: 'admin', permissions: ['read', 'write'] },
//     { roleId: 'projects/admin', resource: 'projects', role: 'admin', permissions: ['read', 'write', 'remove'] }
//   ]
// }
```

Role IDs combine the resource and role name: `projects/reader` for a table role, `@shared/admin` for a shared role. Grant and inspection results use the same IDs, so the catalog is the lookup table for labels and permissions. A role without a `label` uses its name.

#### Offer the roles that can be granted at a scope

For a "share this project" dialog, offer the shared and table roles whose `assignableScopes` include the scope type:

```ts
const projectRoleOptions = [...catalog.sharedRoles, ...projectResource.roles]
  .filter(role => role.assignableScopes.includes('project'))
  .map(role => ({ id: role.id, label: role.label }));
// [
//   { id: 'projects/reader', label: 'Project reader' },
//   { id: 'projects/admin', label: 'admin' }
// ]

const organisationRoleOptions = catalog.sharedRoles
  .filter(role => role.assignableScopes.includes('organisation'))
  .map(role => ({ id: role.id, label: role.label }));
// [{ id: '@shared/organisationAdmin', label: 'Organisation administrator' }]
```

Map the chosen ID back to the role reference you pass to `grant()`, such as `projects.$access.roles.reader` or `organisationAdmin`.

Add display metadata to any role with `label` and `description`:

```ts
const support = role('support', {
  label: 'Support agent',
  description: 'Access the table roles that opt into Support.'
});
```

Register shared roles in `withAuthorization`'s `roles` option to list them before any table includes them.

### List users with their roles and permissions

A user can hold several grants, so there are two useful shapes: one row per grant, or one row per user with an array of grants. Both start from your users table and left join `grantsQuery()`, which keeps users without grants and includes grants at every scope.

#### One row per grant

```ts
const assignments = secured.access.grantsQuery().as('user_assignments');

const rows = await adminDb
  .select({
    id: users.id,
    name: users.name,
    grant: {
      id: assignments.id,
      roleId: assignments.roleId,
      roleKind: assignments.roleKind,
      label: assignments.label,
      scopeName: assignments.scopeName,
      scopeId: assignments.scopeId,
      status: assignments.status
    }
  })
  .from(users)
  .leftJoin(assignments, and(eq(assignments.principalKind, 'user'), eq(assignments.principalId, users.id)))
  .orderBy(users.id, assignments.roleId, assignments.scopeId);
```

This is one database statement. Each user appears once per grant, and once with `grant: null` if they have none. Bob appears twice because he holds two roles, and Erin twice because she holds the same role at two projects:

```ts
[
  {
    id: 'alice',
    name: 'Alice',
    grant: {
      id: '63634630-…',
      roleId: '@shared/admin',
      roleKind: 'shared',
      label: 'Administrator',
      scopeName: 'global',
      scopeId: '',
      status: 'active'
    }
  },
  {
    id: 'bob',
    name: 'Bob',
    grant: {
      id: '86f3fe87-…',
      roleId: '@shared/organisationAdmin',
      roleKind: 'shared',
      label: 'Organisation administrator',
      scopeName: 'organisation',
      scopeId: 'globex',
      status: 'active'
    }
  },
  {
    id: 'bob',
    name: 'Bob',
    grant: {
      id: '180d43d6-…',
      roleId: 'projects/reader',
      roleKind: 'table',
      label: 'Project reader',
      scopeName: 'project',
      scopeId: 'apollo',
      status: 'active'
    }
  },
  { id: 'cara', name: 'Cara', grant: null },
  {
    id: 'dana',
    name: 'Dana',
    grant: {
      id: 'a85851d1-…',
      roleId: '@shared/organisationAdmin',
      roleKind: 'shared',
      label: 'Organisation administrator',
      scopeName: 'organisation',
      scopeId: 'acme',
      status: 'active'
    }
  },
  {
    id: 'erin',
    name: 'Erin',
    grant: {
      id: 'f6d070d6-…',
      roleId: 'projects/reader',
      roleKind: 'table',
      label: 'Project reader',
      scopeName: 'project',
      scopeId: 'atlas',
      status: 'expired'
    }
  },
  {
    id: 'erin',
    name: 'Erin',
    grant: {
      id: '9af725cc-…',
      roleId: 'projects/reader',
      roleKind: 'table',
      label: 'Project reader',
      scopeName: 'project',
      scopeId: 'gemini',
      status: 'active'
    }
  }
];
```

Other available columns are `principalKind`, `principalId`, `resource`, `role`, `description`, `startsAt`, `expiresAt`, `active`, and `known`. The global scope's ID is an empty string. `status` is `'active'`, `'pending'`, or `'expired'`; `known: false` marks grants for roles no longer in the catalog, with `label` falling back to the stored role name.

Always join on both principal kind and ID, because `user('1')` and `device(1)` are different principals. Principal IDs are stored as text; if `users.id` is an integer, join with ``eq(assignments.principalId, sql`${users.id}::text`)``.

#### One object per user, with each role's permissions

Group those rows in memory and resolve what each role allows from the catalog. No further queries are needed:

```ts
const roleById = new Map(
  [...catalog.sharedRoles, ...catalog.resources.flatMap(resource => resource.roles)].map(role => [role.id, role])
);

/** Permissions per table: a table role's own, or everything a shared role includes. */
function permissionsOf(roleId: string): Record<string, string[]> {
  const role = roleById.get(roleId);
  if (!role) return {};
  if (role.roleKind === 'table') return { [role.resource]: role.permissions };
  return Object.fromEntries(role.includes.map(member => [member.resource, member.permissions]));
}

interface UserRole {
  role: string;
  label: string;
  scope: string;
  status: string;
  permissions: Record<string, string[]>;
}
interface UserWithRoles {
  id: string;
  name: string;
  roles: UserRole[];
}

const byUser = new Map<string, UserWithRoles>();
for (const row of rows) {
  const entry = byUser.get(row.id) ?? { id: row.id, name: row.name, roles: [] };
  if (row.grant)
    entry.roles.push({
      role: row.grant.roleId,
      label: row.grant.label,
      scope: row.grant.scopeName === 'global' ? 'global' : `${row.grant.scopeName}:${row.grant.scopeId}`,
      status: row.grant.status,
      permissions: permissionsOf(row.grant.roleId)
    });
  byUser.set(row.id, entry);
}
const usersWithRoles = [...byUser.values()];
```

```ts
// usersWithRoles
[
  {
    id: 'alice',
    name: 'Alice',
    roles: [
      {
        role: '@shared/admin',
        label: 'Administrator',
        scope: 'global',
        status: 'active',
        permissions: {
          devices: ['read', 'write', 'remove'],
          locations: ['read', 'write', 'remove'],
          metrics: ['read', 'write', 'remove'],
          organisationUsers: ['listUsers', 'addUsers', 'removeUsers'],
          organisations: ['read', 'write'],
          projects: ['read', 'write', 'remove']
        }
      }
    ]
  },
  {
    id: 'bob',
    name: 'Bob',
    roles: [
      {
        role: '@shared/organisationAdmin',
        label: 'Organisation administrator',
        scope: 'organisation:globex',
        status: 'active',
        permissions: {
          devices: ['read', 'write', 'remove'],
          locations: ['read', 'write', 'remove'],
          metrics: ['read', 'write', 'remove'],
          organisationUsers: ['listUsers', 'addUsers', 'removeUsers'],
          organisations: ['read', 'write'],
          projects: ['read', 'write', 'remove']
        }
      },
      {
        role: 'projects/reader',
        label: 'Project reader',
        scope: 'project:apollo',
        status: 'active',
        permissions: { projects: ['read'] }
      }
    ]
  },
  { id: 'cara', name: 'Cara', roles: [] },
  {
    id: 'dana',
    name: 'Dana',
    roles: [
      {
        role: '@shared/organisationAdmin',
        label: 'Organisation administrator',
        scope: 'organisation:acme',
        status: 'active',
        permissions: {
          devices: ['read', 'write', 'remove'],
          locations: ['read', 'write', 'remove'],
          metrics: ['read', 'write', 'remove'],
          organisationUsers: ['listUsers', 'addUsers', 'removeUsers'],
          organisations: ['read', 'write'],
          projects: ['read', 'write', 'remove']
        }
      }
    ]
  },
  {
    id: 'erin',
    name: 'Erin',
    roles: [
      {
        role: 'projects/reader',
        label: 'Project reader',
        scope: 'project:atlas',
        status: 'expired',
        permissions: { projects: ['read'] }
      },
      {
        role: 'projects/reader',
        label: 'Project reader',
        scope: 'project:gemini',
        status: 'active',
        permissions: { projects: ['read'] }
      }
    ]
  }
];
```

Keep permissions attached to the grant that supplies them rather than merging them per user, because each applies only within its own scope. Bob can read, write, and remove Globex's projects, but only read Apollo; a merged `projects: ['read', 'write', 'remove']` would wrongly suggest he can edit Apollo. Likewise, Erin's expired Atlas grant currently allows nothing. To ask what someone can actually do at a particular resource, use [inspection](#show-everyones-access-to-one-resource).

#### One row per user, aggregated in SQL

To return each user's grants as an array straight from the database, group by user and aggregate:

```ts
interface GrantSummary {
  roleId: string;
  label: string;
  scopeName: string;
  scopeId: string;
  status: 'active' | 'pending' | 'expired';
}

const usersWithGrants = await adminDb
  .select({
    id: users.id,
    name: users.name,
    roles: sql<GrantSummary[]>`coalesce(
      json_agg(
        json_build_object(
          'roleId', ${assignments.roleId},
          'label', ${assignments.label},
          'scopeName', ${assignments.scopeName},
          'scopeId', ${assignments.scopeId},
          'status', ${assignments.status}
        )
        order by ${assignments.roleId}, ${assignments.scopeId}
      ) filter (where ${assignments.id} is not null),
      '[]'
    )`
  })
  .from(users)
  .leftJoin(assignments, and(eq(assignments.principalKind, 'user'), eq(assignments.principalId, users.id)))
  .groupBy(users.id, users.name)
  .orderBy(users.id)
  .limit(25);
```

```ts
[
  {
    id: 'alice',
    name: 'Alice',
    roles: [{ roleId: '@shared/admin', label: 'Administrator', scopeName: 'global', scopeId: '', status: 'active' }]
  },
  {
    id: 'bob',
    name: 'Bob',
    roles: [
      {
        roleId: '@shared/organisationAdmin',
        label: 'Organisation administrator',
        scopeName: 'organisation',
        scopeId: 'globex',
        status: 'active'
      },
      { roleId: 'projects/reader', label: 'Project reader', scopeName: 'project', scopeId: 'apollo', status: 'active' }
    ]
  },
  { id: 'cara', name: 'Cara', roles: [] },
  {
    id: 'dana',
    name: 'Dana',
    roles: [
      {
        roleId: '@shared/organisationAdmin',
        label: 'Organisation administrator',
        scopeName: 'organisation',
        scopeId: 'acme',
        status: 'active'
      }
    ]
  },
  {
    id: 'erin',
    name: 'Erin',
    roles: [
      { roleId: 'projects/reader', label: 'Project reader', scopeName: 'project', scopeId: 'atlas', status: 'expired' },
      { roleId: 'projects/reader', label: 'Project reader', scopeName: 'project', scopeId: 'gemini', status: 'active' }
    ]
  }
];
```

The `filter` clause turns a user without grants into an empty array rather than an array containing one null grant. Because there is one row per user, `limit` and `offset` page through users. Add catalog permissions with `permissionsOf` as above.

#### Include only active grants

```ts
const activeAssignments = secured.access.grantsQuery({ active: true }).as('active_assignments');
```

Use `activeAssignments` in place of `assignments` in any of the queries above, and Erin keeps only her Gemini grant. Filtering inside the subquery keeps users without active grants, such as Cara; a `where active = true` after the left join would drop them.

#### Paginate the one-row-per-grant query

With one row per grant, a `limit` counts grants, so Bob's or Erin's grants could be split across pages. Either aggregate in SQL as above, or page the users first and join their grants:

```ts
const userPage = adminDb
  .select({ id: users.id, name: users.name })
  .from(users)
  .orderBy(users.id)
  .limit(25)
  .offset(0)
  .as('user_page');

const pageRows = await adminDb
  .select({
    id: userPage.id,
    name: userPage.name,
    roleId: assignments.roleId,
    label: assignments.label,
    scopeName: assignments.scopeName,
    scopeId: assignments.scopeId
  })
  .from(userPage)
  .leftJoin(assignments, and(eq(assignments.principalKind, 'user'), eq(assignments.principalId, userPage.id)))
  .orderBy(userPage.id, assignments.id);
```

The result covers 25 users but can contain more than 25 rows. Group it in memory as above.

### Show everyone's access to one resource

`inspectQuery()` answers "who can do what at Apollo?". It follows shared roles and grants inherited from ancestor scopes, and returns one row per principal:

```ts
const apolloAccess = secured.access.inspectQuery({ resource: projects, scope: apollo }).as('apollo_access');

const accessRows = await adminDb
  .select({
    id: users.id,
    name: users.name,
    roles: apolloAccess.roles,
    permissions: apolloAccess.permissions
  })
  .from(users)
  .leftJoin(apolloAccess, and(eq(apolloAccess.principalKind, 'user'), eq(apolloAccess.principalId, users.id)))
  .orderBy(users.id);
```

```ts
[
  { id: 'alice', name: 'Alice', roles: ['@shared/admin'], permissions: ['read', 'remove', 'write'] },
  { id: 'bob', name: 'Bob', roles: ['projects/reader'], permissions: ['read'] },
  { id: 'cara', name: 'Cara', roles: null, permissions: null },
  { id: 'dana', name: 'Dana', roles: ['@shared/organisationAdmin'], permissions: ['read', 'remove', 'write'] },
  { id: 'erin', name: 'Erin', roles: null, permissions: null }
];
```

Alice's access comes from the global scope and Dana's from Acme. Bob holds two roles, but only his project reader grant applies here; his Globex administration does not reach an Acme project. Erin's Gemini grant does not reach Apollo either, so she has nulls like Cara. `roles` holds the IDs of the active grants that contribute, and `permissions` the effective action names, sorted. A principal whose only relevant grants are pending or expired gets empty arrays rather than nulls. Because the subquery has at most one row per principal, a `limit` here counts users.

Map the arrays into flags for a UI:

```ts
const apolloMembers = accessRows.map(row => ({
  name: row.name,
  canRead: row.permissions?.includes('read') ?? false,
  canWrite: row.permissions?.includes('write') ?? false,
  canRemove: row.permissions?.includes('remove') ?? false
}));
```

Or filter by permission in SQL with PostgreSQL array operators:

```ts
const apolloWriters = await adminDb
  .select({ id: users.id, name: users.name })
  .from(users)
  .innerJoin(apolloAccess, and(eq(apolloAccess.principalKind, 'user'), eq(apolloAccess.principalId, users.id)))
  .where(arrayContains(apolloAccess.permissions, ['write']))
  .orderBy(users.id);
// [{ id: 'alice', name: 'Alice' }, { id: 'dana', name: 'Dana' }]
```

### Find everyone with a role in a scope

"Who has this role here?" has three useful readings. Pick the one your screen means.

#### Granted at exactly this scope

Filter `grantsQuery()` by role and scope:

```ts
const acmeAdmins = secured.access.grantsQuery({ role: organisationAdmin, scope: acme, active: true }).as('acme_admins');

const acmeAdminUsers = await adminDb
  .select({ id: users.id, name: users.name })
  .from(users)
  .innerJoin(acmeAdmins, and(eq(acmeAdmins.principalKind, 'user'), eq(acmeAdmins.principalId, users.id)));
// [{ id: 'dana', name: 'Dana' }]
```

Alice is not listed: her global `admin` grant gives her the same permissions, but she was not granted `organisationAdmin` at Acme. Omit `role` to list every grant made at Acme.

#### Granted anywhere inside this scope

Grants are stored against the scope they were made at, so a grant on an Acme project is stored against that project. Join the grants to your scope tables to include descendants:

```ts
const activeGrants = secured.access.grantsQuery({ active: true }).as('active_grants');
const acmeProjectIds = adminDb.select({ id: projects.id }).from(projects).where(eq(projects.organisationId, 'acme'));
const acmeDeviceIds = adminDb
  .select({ id: sql<string>`${devices.id}::text` })
  .from(devices)
  .where(eq(devices.organisationId, 'acme'));

const grantsInsideAcme = await adminDb
  .select({
    id: users.id,
    name: users.name,
    roleId: activeGrants.roleId,
    scopeName: activeGrants.scopeName,
    scopeId: activeGrants.scopeId
  })
  .from(activeGrants)
  .innerJoin(users, and(eq(activeGrants.principalKind, 'user'), eq(activeGrants.principalId, users.id)))
  .where(
    or(
      and(eq(activeGrants.scopeName, 'organisation'), eq(activeGrants.scopeId, 'acme')),
      and(eq(activeGrants.scopeName, 'project'), inArray(activeGrants.scopeId, acmeProjectIds)),
      and(eq(activeGrants.scopeName, 'device'), inArray(activeGrants.scopeId, acmeDeviceIds))
    )
  )
  .orderBy(users.id);
```

```ts
[
  { id: 'bob', name: 'Bob', roleId: 'projects/reader', scopeName: 'project', scopeId: 'apollo' },
  { id: 'dana', name: 'Dana', roleId: '@shared/organisationAdmin', scopeName: 'organisation', scopeId: 'acme' }
];
```

Scope IDs are stored as text, so integer keys such as `devices.id` are cast before comparing. Erin's Atlas grant is excluded because it has expired. To answer "who reads which Acme project?", filter by the role and join the project itself:

```ts
const projectReaders = secured.access.grantsQuery({ role: projects.$access.roles.reader }).as('project_readers');

const acmeProjectReaders = await adminDb
  .select({
    user: users.name,
    project: projects.name,
    status: projectReaders.status,
    expiresAt: projectReaders.expiresAt
  })
  .from(projectReaders)
  .innerJoin(users, and(eq(projectReaders.principalKind, 'user'), eq(projectReaders.principalId, users.id)))
  .innerJoin(projects, and(eq(projectReaders.scopeName, 'project'), eq(projectReaders.scopeId, projects.id)))
  .where(eq(projects.organisationId, 'acme'))
  .orderBy(users.name);
```

```ts
[
  { user: 'Bob', project: 'Apollo', status: 'active', expiresAt: null },
  { user: 'Erin', project: 'Atlas', status: 'expired', expiresAt: new Date('2026-10-01T00:00:00.000Z') }
];
```

#### Holding it here, including from a parent scope

To find who has a role in effect at a resource, including grants made higher up, filter `inspectQuery()` by role ID:

```ts
const apolloOrganisationAdmins = await adminDb
  .select({ id: users.id, name: users.name, roles: apolloAccess.roles })
  .from(users)
  .innerJoin(apolloAccess, and(eq(apolloAccess.principalKind, 'user'), eq(apolloAccess.principalId, users.id)))
  .where(arrayContains(apolloAccess.roles, ['@shared/organisationAdmin']));
// [{ id: 'dana', name: 'Dana', roles: ['@shared/organisationAdmin'] }]
```

Dana's grant was made at Acme, but it is in effect at Apollo. `roles` contains the IDs of the roles that were granted, so a shared grant appears under its shared ID rather than as `projects/admin`.

#### Devices and other principal kinds

The same queries work for any principal kind. Join on its kind and cast integer IDs to text:

```ts
const writers = secured.access.grantsQuery({ role: metrics.$access.roles.writer, active: true }).as('metric_writers');

const devicesWithWriterRoles = await adminDb
  .selectDistinct({ id: devices.id })
  .from(devices)
  .innerJoin(writers, and(eq(writers.principalKind, 'device'), eq(writers.principalId, sql`${devices.id}::text`)));
```

`selectDistinct` collapses a device with several overlapping grant windows into one row.

### Explain one person's access

`inspect()` explains one principal's decision for every action at a resource, with the grants behind it:

```ts
const bobAtApollo = await secured.access.inspect({ principal: user('bob'), resource: projects, scope: apollo });
```

```ts
{
  principal: { kind: 'user', id: 'bob' },
  resource: 'projects',
  scope: { name: 'project', id: 'apollo' },
  evaluatedAt: new Date('2026-10-12T09:00:00.000Z'),
  roles: [
    {
      assignmentId: '180d43d6-…',
      roleId: 'projects/reader',
      role: 'reader',
      roleKind: 'table',
      label: 'Project reader',
      description: 'Read this project.',
      scope: { name: 'project', id: 'apollo' },
      resource: 'projects',
      startsAt: null,
      expiresAt: null,
      status: 'active',
      active: true,
      inherited: false
    }
  ],
  permissions: {
    read: {
      allowed: true,
      grantedBy: [
        {
          assignmentId: '180d43d6-…',
          roleId: 'projects/reader',
          role: 'reader',
          roleKind: 'table',
          label: 'Project reader',
          description: 'Read this project.',
          scope: { name: 'project', id: 'apollo' },
          through: 'projects.reader'
        }
      ]
    },
    write: { allowed: false, grantedBy: [] },
    remove: { allowed: false, grantedBy: [] }
  }
}
```

For Dana, the same call shows a grant inherited from Acme, contributing through the project table's `admin` role:

```ts
const danaAtApollo = await secured.access.inspect({ principal: user('dana'), resource: projects, scope: apollo });

danaAtApollo.roles[0];
// { roleId: '@shared/organisationAdmin', label: 'Organisation administrator', scope: { name: 'organisation', id: 'acme' },
//   inherited: true, status: 'active', active: true, … }
danaAtApollo.permissions.write;
// { allowed: true, grantedBy: [{ roleId: '@shared/organisationAdmin', scope: { name: 'organisation', id: 'acme' }, through: 'projects.admin', … }] }
```

Every action has a decision. Pending and expired grants appear in `roles` but never in `grantedBy`. A principal without relevant grants, or a scope row that does not exist, gets denials for every action.

### List grants at a scope

```ts
const reachingApollo = await secured.access.at(apollo).list({ includeInherited: true });
```

```ts
[
  {
    id: '63634630-…',
    principalKind: 'user',
    principalId: 'alice',
    resource: '@shared',
    role: 'admin',
    scopeName: 'global',
    scopeId: '',
    startsAt: null,
    expiresAt: null
  },
  {
    id: '180d43d6-…',
    principalKind: 'user',
    principalId: 'bob',
    resource: 'projects',
    role: 'reader',
    scopeName: 'project',
    scopeId: 'apollo',
    startsAt: null,
    expiresAt: null
  },
  {
    id: 'a85851d1-…',
    principalKind: 'user',
    principalId: 'dana',
    resource: '@shared',
    role: 'organisationAdmin',
    scopeName: 'organisation',
    scopeId: 'acme',
    startsAt: null,
    expiresAt: null
  }
];
```

Without `includeInherited`, only Bob's grant at Apollo itself is returned. These are raw stored grants, including any for roles that no longer apply to projects; use `inspectQuery()` for effective access.

### Revoke grants

```ts
const grant = await secured.access.root().grant({ principal: user('alice'), role: admin });

await secured.access.revoke(grant.id); // true
await secured.access.at(apollo).revoke({ principal: user('bob'), role: projects.$access.roles.reader });
```

Revoking by ID removes one grant. Revoking by principal and role at a scope removes all of its windows there. Other grants, shared or direct, are unaffected.

### Report freshness

The catalog reflects the loaded definitions. Reports read current grants when executed, using an evaluation time captured when the query builder is created. Pass the same `now` to several builders for a consistent report time. Report builders are ordinary Drizzle selects that support aliases, filters, grouping, pagination, counts, and CTEs; their option filters stay inside the source relation when you add an outer `.where()`.

Reports describe the resource and scope you supply. They do not trace every route by which a particular row could be reached through other scope bindings, such as a comment reached through its author's `self` grant. Request sessions enforce all bindings. Joining reports to your tables uses the admin connection, so those joins are not themselves filtered by access.

## Boundaries and lifecycle

The library decides whether a principal may perform an operation on a row. Your application remains responsible for:

- **Authentication.** `user()`, `device()`, and `principal()` do not authenticate anyone. Create sessions only for verified principals.
- **Who may grant.** Creating a grant does not authorize anyone to manage grants. Protect any endpoint that calls `secured.access`.
- **Provisioning.** Create scope rows before granting at them, and grant roles at sign-up, invitation, and similar events. Role names such as `self` or `signedIn` mean nothing until you grant them.
- **Ownership fields.** Policies check where a row belongs, not that `authorId` equals the principal. Set such fields from the session's principal.
- **Offboarding and deletion.** Revoke grants and delete or detach rows when membership ends, and delete grants when you delete a scope row. Do not reuse scope or principal IDs while old grants remain.
- **Definition changes.** Resource, scope, and shared role names are stored in grants; renaming one means migrating them. Run `umbrella generate` whenever definitions change, and use `--before` when changing a scope key or link column's type.
- **Database privileges.** RLS chooses rows; table and column privileges on the `app` role choose what can be touched at all. Keep the `app` role away from authentication tables and from the grants table.
- **Transaction isolation.** Checks read grants in the query's own transaction. A long repeatable-read transaction keeps seeing the grants that existed when it started.
