# Studio API

The conservation.tv studio API: a Cloudflare Worker (Hono) backed by Postgres through Hyperdrive, built the same way
as [gatekeeper](../../controlplane/gatekeeper). Its API is versioned per operation and publishes an OpenAPI bundle
from which the SDK (`../sdk`) and CLI (`../cli`) are generated; the versioning router, contract generation, release
gates and generators are shared through [`@conservationtv/versioned-api`](../../../packages/versioned-api).

Unlike gatekeeper, requests run as a signed-in account and the database decides what that account can see:
authorization is [`@conservationtv/umbrella`](../../../packages/umbrella), which compiles access definitions written
beside each Drizzle table into PostgreSQL row-level security. Read its [guide](../../../packages/umbrella/GUIDE.md).

Not deployed yet: there is no Pulumi stack, and the Hyperdrive bindings are placeholders.

## Endpoints

| Route            | Audience | Contract                                                 |
| ---------------- | -------- | -------------------------------------------------------- |
| `GET /health`    | anyone   | `health.get`, versionless                                |
| `GET /account`   | accounts | `account.get` v1: the signed-in account                  |
| `PATCH /account` | accounts | `account.update` v1: its profile fields (`name`, `image`) |
| `GET /organisations` | accounts | `organisations.list` v1: the organisations it is a member of |
| `POST /organisations` | accounts | `organisations.create` v1: a new organisation, administered by its creator |
| `GET /organisations/{id}` | members | `organisations.get` v1 |
| `PATCH /organisations/{id}` | administrators | `organisations.update` v1: its `name` |
| `DELETE /organisations/{id}` | global administrators | `organisations.delete` v1: with its memberships, profiles, invitations and grants |
| `GET /organisations/{id}/members` | members | `organisations.members.list` v1: the directory, with each member's profile |
| `PATCH /organisations/{id}/members/me` | members | `organisations.members.updateSelf` v1: your `displayName` there |
| `DELETE /organisations/{id}/members/{userId}` | administrators, or `me` | `organisations.members.remove` v1: remove a member, or leave |
| `GET /organisations/{id}/invitations` | administrators | `organisations.invitations.list` v1 |
| `POST /organisations/{id}/invitations` | administrators | `organisations.invitations.create` v1: an `email` (sent a link) or a `userId` |
| `DELETE /organisations/{id}/invitations/{invitationId}` | administrators | `organisations.invitations.cancel` v1 |
| `GET /invitations` | accounts | `invitations.listMine` v1: open invitations to the signed-in account |
| `GET /invitations/{id}` | anyone with the link | `invitations.get` v1: the organisation it is for |
| `POST /invitations/{id}/accept` | invitees | `invitations.accept` v1: join, with a `displayName` and an emailed invitation's `code` |
| `POST /invitations/{id}/decline` | invitees | `invitations.decline` v1 |
| `GET`, `POST /organisations/{id}/networks`; `GET`, `PATCH`, `DELETE …/networks/{networkId}` | members read, administrators write | `organisations.networks.*` v1 |
| `PUT /organisations/{id}/networks/{networkId}/active-agent` | administrators | `organisations.networks.setActiveAgent` v1 |
| `GET /organisations/{id}/devices`; `GET`, `PATCH …/devices/{deviceId}` | members read, administrators rename and move | `organisations.devices.*` v1: every kind |
| `GET`, `POST /organisations/{id}/cameras`; `GET`, `PATCH`, `DELETE …/cameras/{cameraId}` | members read, administrators write | `organisations.cameras.*` v1 |
| `PUT /organisations/{id}/browser` | members | `organisations.browser.ensure` v1: this session's browser device, with its private key |
| `GET`, `POST /organisations/{id}/agents`; `GET`, `PATCH`, `DELETE …/agents/{agentId}` | members read, administrators write | `organisations.agents.*` v1 |
| `…/agents/{agentId}/revisions` (list, create, get), `PUT …/served-revision` | members read, administrators write | `organisations.agents.revisions.*`, `serveRevision` v1 |
| `GET`, `POST /organisations/{id}/streams`; `GET`, `PATCH`, `DELETE …/streams/{streamId}` | members read, administrators write | `organisations.streams.*` v1 |
| `…/streams/{streamId}/exposures`, `…/recorders` (create, update, delete) | administrators | `organisations.streams.exposures.*`, `.recorders.*` v1 |
| `/organisations/{id}/subjects/{subjectId}/state`, `…/observations`, `…/metrics`, `…/logs` | members | `organisations.subjects.*` v1 |
| `POST /reports` | agents, by signature | `reports.submit` v1: a signed batch of events, metrics and logs |
| `GET /openapi.json` | SDK/CLI | the published capability bundle                        |
| `/auth/*`        | accounts | Better Auth's routes, hidden from the contract           |

Request and response fields are camelCase. Failures use the shared `{ "error", "error_description" }`: 400 for malformed requests, 401 without a session, 403 when the row
is visible but the account may not change it (or `invalid_invitation_code`), 404 when the row is not visible to the
account (or `account_not_found` for an invitation), 409 for `already_member`, `already_invited` and `last_admin`, 410
for `invitation_expired`, 412 for an unserved operation version, and 503 when the database is unavailable.

## Authentication

[Better Auth](https://www.better-auth.com) is mounted at `/auth` (`src/auth/auth.ts`). There are no passwords, and
organisations are this API's own tables rather than Better Auth's (see [Organisations](#organisations)):

- **Sign-up and sign-in** by emailed one-time code (`emailOTP`): `POST /auth/email-otp/send-verification-otp` with
  `{ email, type: "sign-in" }`, then `POST /auth/sign-in/email-otp` with `{ email, otp }`. A new email creates the
  account.
- **Devices** (the CLI) by the OAuth device flow (`deviceAuthorization`): the device asks `/auth/device/code` for a
  code as client `studio-cli`, shows it, and polls `/auth/device/token`; the person approves it in the web app at
  `<first WEB_ORIGINS entry>/device`, signing in there first if needed. The token is sent as
  `Authorization: Bearer …` (the `bearer` plugin), so `requirePrincipal` needs no cookie.
- **Passkeys** as an alternative sign-in only: `/auth/passkey/generate-register-options` and `/auth/passkey/verify-registration`
  need an existing session, so a passkey can never create an account; `/auth/sign-in/passkey` signs in with one. The
  relying party is `APP_URL`'s host, with `APP_URL` and `WEB_ORIGINS` as allowed origins.

`requirePrincipal` (`src/middleware/principal.ts`) resolves the session cookie with `auth.api.getSession` and runs
the rest of the request with its umbrella principal, `user(<account id>)`, which handlers read with `usePrincipal()`. Better Auth itself uses the admin connection and owns its
tables; request handlers never query them.

Codes are delivered according to `OTP_DELIVERY`. Only `log` exists, which prints the code to the Worker's log for
local development; the configuration schema accepts nothing else, so a deployment fails closed until an email
provider is wired into `src/auth/otp.ts`.

## Authorization

`src/db/schemas/users.ts` wraps Better Auth's `user` table with `withAccess`: each account is its own `user` scope, with
`read` and `edit` actions and an `owner` role that opts into the shared `self` role (`src/db/roles.ts`). When Better
Auth creates an account, a `databaseHooks.user.create.after` hook grants `self` at that account's scope. Email,
verification and creation time are immutable through request sessions.

`src/access.ts` compiles the definitions once with `defineAuthorization`. Handlers run queries inside
`useServices().session(principal)`, a session over the application connection only, so an account can only ever read or
update its own row; a different account's row is simply absent. Only Better Auth's provisioning hooks and the membership operations (see [Organisations](#organisations)) hold
`authorization.access(admin)`, and a request that never grants opens no admin connection. Umbrella needs two database roles, so there are two Hyperdrive
bindings:

| Binding               | Kind       | Purpose                                                                 |
| --------------------- | ---------- | ----------------------------------------------------------------------- |
| `HYPERDRIVE_ADMIN`    | Hyperdrive | the owning role: migrations, Better Auth, grants                         |
| `HYPERDRIVE_APP`      | Hyperdrive | the application role (`studio_app`): request sessions, under RLS        |
| `BETTER_AUTH_SECRET`  | secret     | Better Auth's signing secret                                            |
| `FIELD_KEY`           | secret     | base64 32-byte master key for encrypted columns and blind indexes       |
| `APP_URL`             | text       | where the API is served; Better Auth's base URL and passkey relying party |
| `WEB_ORIGINS`         | text       | comma-separated browser origins allowed with credentials; the first hosts `/device` |
| `OTP_DELIVERY`        | text       | `log` only, see above                                                   |

The application role is `studio_app` in every environment: `docker/init.sql` creates it locally. Its privileges on
every protected table are generated, not written: `umbrella generate --role studio_app` derives them from the access
definitions in each access-policies migration (every operation an action declares except `trusted` ones; `select`
of every column but `hidden` ones; `update` of every column that is not a primary key, generated or immutable), and
replaces whatever the role held before. The only hand-written grant left is `grants_readable`, on umbrella's own
grants table. Umbrella refuses to run request sessions on a connection that could bypass row-level security.

## Develop

```sh
pnpm install
pnpm --filter @conservationtv/studio-api db:up       # docker-compose Postgres 18 on :5434, with both roles
pnpm --filter @conservationtv/studio-api db:migrate
cp .dev.vars.example .dev.vars                       # then set BETTER_AUTH_SECRET and FIELD_KEY
pnpm --filter @conservationtv/studio-api dev         # http://localhost:5175
```

Sign in from the terminal with the CLI, which opens the device flow (the web app must be running for the approval
page), or with curl: request a code, read it from the dev server's log (`"event":"email_otp"`), exchange it, and use
the returned session cookie:

```sh
pnpm --filter @conservationtv/studio-cli cli login && pnpm --filter @conservationtv/studio-cli cli account get v1

curl -X POST localhost:5175/auth/email-otp/send-verification-otp -H 'content-type: application/json' \
  -H 'origin: http://localhost:5173' -d '{"email":"you@example.com","type":"sign-in"}'
curl -c jar -X POST localhost:5175/auth/sign-in/email-otp -H 'content-type: application/json' \
  -H 'origin: http://localhost:5173' -d '{"email":"you@example.com","otp":"<code>"}'
curl -b jar localhost:5175/account
```

Schema changes: edit the tables in `src/db/schemas/` (`src/db/schema.ts` exports everything drizzle-kit migrates), then `pnpm db:generate` (drizzle-kit, then `umbrella generate --role studio_app` for the
access policies and privileges) and commit the migrations in `drizzle/`. Regenerate Better Auth's tables with `pnpm auth:generate`
after changing its plugins; the access definitions live beside it in `src/db/schemas/`, so regeneration never overwrites them.
Relational queries (`db.query`, also inside request sessions) use the relations in `src/db/relations.ts`.

Request handling reads its dependencies through `useServices()`, a `createStore` from `@conservationtv/store`
(AsyncLocalStorage, `src/services.ts`). Only the production Worker entrypoint constructs them, through
`servicesFor` (`src/services-for.ts`); the database clients, the authorization client and Better Auth open on first use within a request. The
text bindings and secrets are validated by `src/config.ts` (ArkEnv over `process.env`) on the first request in each
isolate; an invalid deployment fails every request.

## Organisations

An account can belong to any number of organisations. Four tables, in `src/db/schemas/organisations.ts` and `invitations.ts`, with IDs from
Postgres's `uuidv7()` (so Postgres 18 or newer):

- `organisation`: its own `organisation` scope.
- `organisation_membership`: one per account and organisation. Members read every membership of their organisations,
  and each account reads its own.
- `organisation_profile`: what members see of each other (`display_name`), one per membership and deleted with it. The
  account behind it stays private. Each account edits its own profiles, and administrators edit any in their
  organisation.
- `organisation_invitation`: an open invitation, to either an account (`user_id`) or an `email` address, lasting 14
  days. An emailed invitation is sent a link to `<first WEB_ORIGINS entry>/invitations/{id}?code=…` (delivered by
  `OTP_DELIVERY`, so only logged for now); only the code's hash is stored, and the application role cannot read it.
  Whoever signs in and presents the code may accept, so an invitation can be passed on to another address. An
  invitation to an account is accepted by signing in as it.

Access comes from shared roles granted at the organisation (`src/db/roles.ts`): `organisationMember` (read the
organisation, its memberships and directory) and `organisationAdmin` (rename the organisation, manage invitations,
remove members, edit profiles). Deleting an organisation needs `globalAdmin`, granted only at the global scope and only
by trusted code: nothing in the API grants it, so make an operator one with
`authorization.access(admin).root().grant({ principal: user(id), role: globalAdmin })`. The creator of an organisation
is its first administrator; there is no endpoint to make others yet.

Administrators create, list and cancel invitations in their request session (`src/organisations/invitations.ts`): that
changes no grants, so row-level security alone decides who may. The invitee's side (reading an invitation by its link,
listing your own, accepting, declining) is trusted code, because an emailed invitation belongs to no account until
someone presents its code. Creating an organisation, joining, removing and deleting change grants as well as rows, so
they run as trusted code in one admin transaction (`src/organisations/membership.ts`), taking their decisions from the
access definitions through `inspect`. Changes to an organisation's administrators lock its row, and its last
administrator cannot leave or be removed. Deleting an organisation and removing a member are therefore `trusted` actions: declared for `inspect`, never granted to request sessions.

Request sessions may read umbrella's grants table (the `grants_readable` migration, a select-only policy): the member
directory and your organisation list show roles, and run under row-level security like every other read. A bug in
those routes can therefore leak role assignments, never other data; writes to grants stay with trusted code, which
lists the roles it checks itself (`requireAdmin`, `keepAnotherAdmin`) in its own locked transaction.

## Stream topology

What each organisation runs, in `src/db/schemas/`: networks, devices of three kinds, cameras, agents (which serve the
network they are on, one active at a time) and signed-in browsers, streams with a source device, their exposures (network, protocol, desired
renditions) and recorders (always backed by an exposure of the same stream).

Every row binds to its organisation's scope through `organisation_id`: `organisationMember` reads it all and
`organisationAdmin` manages it, in the request session. References between rows are composite foreign keys that
include `organisation_id`, so the database refuses a reference into another organisation (422 `invalid_reference`)
and a delete of something still used (409 `in_use`). A partial unique index allows one active agent per network, and
one served configuration revision per agent; a check constraint refuses serving a revision whose diagnostics include
an error, so a rejected candidate never replaces the served one.

A device is minimal: a name, a network (or the internet), a `kind` and an Ed25519 identity, generated when it is
created (`src/topology/identity.ts`): `publicKey` (unpadded base64url) and `publicId`, derived as iroh derives an
endpoint ID (the public key bytes in lowercase hex, unique). The private key, the 32-byte seed iroh calls a
`SecretKey`, is stored encrypted and request sessions cannot select it: it is written once, at creation, and only
trusted code can read it. The kind and identity never change.

Everything else belongs to the device's kind, a table whose row shares the device's ID: a `camera` adds its `settings`
(including the endpoints it offers by itself, from which those are derived); an `agent` adds the network it serves (the device's own),
its standby priority and whether it is active. Each kind's table carries its kind as a generated column in a composite
foreign key to the device, so a device is only ever the kind it was created as. `POST …/cameras` and `POST …/agents`
create the device, with its identity, and its kind's row together, and their `DELETE` removes both. Their routes
nest the device's fields under `device`, and an agent its served revision under `servedRevision` (a network its
active agent under `activeAgent`), each read with one relational query (`src/db/relations.ts`). `/devices` lists
every device and renames or moves one, but never creates or deletes: an agent's device cannot change network (409 `in_use`), and a device a stream uses as its source cannot be removed.

A `browser` is one auth session's device in one organisation, for iroh connections from the web app through a relay.
`PUT …/browser` gets or creates it for the session that calls it, in an organisation the account belongs to, and
returns it with its private key (the raw seed, unpadded base64url), so the browser can act as it; concurrent first
requests make one between them. It is trusted code (`src/topology/browsers.ts`), so any member may make their own, and
it is named after the session's user agent. A browser is always on the internet (409 `conflict` if moved), and
belongs to the account as well as the organisation: its row references the auth session and the account's membership.
Neither reference cascades. Instead the code that ends them deletes the browser and its device first: Better Auth's
session-delete hook, which runs for sign-out, bulk revocation, expired sessions and account deletion, and
`endMembership`. A path that forgot would be refused by the foreign key rather than leave a device behind. Members see
every browser under `/devices`, as they see every device; nothing reads a browser's private key but its own session.

Every device is also a principal, `device(<id>)`, in its organisation, holding the shared `organisationDevice` role
there (`src/topology/device-principals.ts`). That role reads the organisation's devices and nothing else, so a device,
like any member, can list its organisation's public IDs for an iroh allowlist. The grant is made in the transaction
that creates the device and revoked in the one that deletes it, so a device never exists without it. Request sessions
cannot write grants, so creating and deleting agents, cameras and browsers is trusted code: `changeDevices` first
checks the principal's own permissions on devices, giving the same 404 or 403 row-level security would. Deleting an
organisation revokes every grant at it. Nothing authenticates a device yet; once something does, it runs queries with
`authorization.as(app, device(id))`.

The only triggers are umbrella's `authz_immutable`, which refuse request sessions' changes to immutable columns.

Agents report to `POST /reports` without a session, in batches. Each submission is `{ publicId, batch, signature }`:
`batch` is the JSON text `{ reporterId, reports: [...] }`, signed once, byte for byte, with the identity of the device
named by `publicId`, which must be the reporting agent's host. A batch holds up to 1000 reports of any kind (`event`,
`metric` or `log`) and subject, each with its own `observedAt`, and the whole submission may be at most 1 MiB.
Ingestion is trusted code (`src/reports/ingest.ts`): it verifies the signature under the device's public key and that
`reporterId` runs on it, refuses malformed reports and those observed more than five minutes ahead, and stores the
batch in that agent's organisation with one insert per kind. Moving an agent to another host moves which key it signs
with. A batch is stored or refused whole, and only for trust or
shape. Nothing is deduplicated, so a retried batch may be stored twice. Request sessions only read reports.

A report's `subjectId` names what it is about by convention (`src/reports/subjects.ts`), not by reference:
`<kind>:<id>` for a network, device, agent, stream or exposure, such as `device:0199e8b2-…`, or `external:<name>` for
anything outside the topology, such as `external:https://example.org`. Nothing checks the entity exists, so reports
about a deleted entity remain. Read them under `/organisations/{id}/subjects/{subjectId}/…`, with the subject
URL-encoded. Metric samples keep the type, unit and dimensions they were reported with; they are not grouped into
series, and samples from different reporters are never summed.

Not built yet: provisioning a device with its private key, rotating or revoking a device identity, the state
consumer that turns observations into `reporter_opinion` and `subject_state` rows (so `…/state` returns `state: null`,
stale, until it exists), failover from expired agent state, the configuration builders that produce revisions, how an
agent fetches its served revision, and sharing across organisations.

## Encrypted columns

`encrypted(purpose, codec)` (`src/db/encrypted.ts`) is a `bytea` column sealed with AES-256-GCM in the application, so
the database and its backups only hold ciphertext. The codec maps plaintext bytes to the column's TypeScript type
(`BytesSchema`, `Utf8Schema`, `json(schema)`, which can nest codecs such as `IsoDatetimeSchema`). Each purpose seals
under its own subkey (HKDF-SHA256 of the field key, the purpose as its info), so a ciphertext copied into another
column fails to open; the purpose must never change, which keeps renamed columns readable. The field key comes from
`FIELD_KEY`, which the config decodes to its 32 bytes (`useServices().config.FIELD_KEY`), so sealing and opening need
the request's services. `blindIndex(purpose, codec, value)` is a keyed hash for equality lookups on an encrypted value,
kept in a column beside it, under its own subkey.

A sealed value is `version ‖ iv ‖ tag ‖ ciphertext`, and the version is always 1: there is one key and no rotation, since
nothing re-seals existing rows yet. The version byte is there so rotation can be added without rewriting stored values.
Rotating would also change every blind index, so those would need recomputing too.

## Contracts, SDK and CLI

```sh
pnpm --filter @conservationtv/studio-api generate             # contracts/openapi.json from routes + handler types
pnpm --filter @conservationtv/studio-sdk generate
pnpm --filter @conservationtv/studio-cli generate
```

`pnpm snapshot studio-api-v1.0.0` freezes the current bundle under `contracts/snapshots/`, and `check:snapshot`,
`check:release` and `ci:contracts` gate releases, as for gatekeeper. No snapshot has been cut yet, so every contract
is still provisional.
