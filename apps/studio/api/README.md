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
| `GET /openapi.json` | SDK/CLI | the published capability bundle                        |
| `/auth/*`        | accounts | Better Auth's routes, hidden from the contract           |

Failures use `{ "error", "error_description" }`: 400 for malformed requests, 401 without a session, 404 when the row
is not visible to the account, 412 for an unserved operation version, and 503 when the database is unavailable.

## Authentication

[Better Auth](https://www.better-auth.com) is mounted at `/auth` (`src/auth/auth.ts`). There are no passwords and no
organisations:

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

`requirePrincipal` (`src/middleware/principal.ts`) resolves the session cookie with `auth.api.getSession` and sets
the request's umbrella principal, `user(<account id>)`. Better Auth itself uses the admin connection and owns its
tables; request handlers never query them.

Codes are delivered according to `OTP_DELIVERY`. Only `log` exists, which prints the code to the Worker's log for
local development; the configuration schema accepts nothing else, so a deployment fails closed until an email
provider is wired into `src/auth/otp.ts`.

## Authorization

`src/db/schema.ts` wraps Better Auth's `user` table with `withAccess`: each account is its own `user` scope, with
`read` and `edit` actions and an `owner` role that opts into the shared `self` role (`src/db/roles.ts`). When Better
Auth creates an account, a `databaseHooks.user.create.after` hook grants `self` at that account's scope. Email,
verification and creation time are immutable through request sessions.

`src/access.ts` compiles the definitions once with `defineAuthorization`. Handlers run queries inside
`services().session(principal)`, a session over the application connection only, so an account can only ever read or
update its own row; a different account's row is simply absent. Only Better Auth's provisioning hooks hold
`authorization.access(admin)`, and a request that never grants opens no admin connection. Umbrella needs two database roles, so there are two Hyperdrive
bindings:

| Binding               | Kind       | Purpose                                                                 |
| --------------------- | ---------- | ----------------------------------------------------------------------- |
| `HYPERDRIVE_ADMIN`    | Hyperdrive | the owning role: migrations, Better Auth, grants                         |
| `HYPERDRIVE_APP`      | Hyperdrive | the application role (`studio_app`): request sessions, under RLS        |
| `BETTER_AUTH_SECRET`  | secret     | Better Auth's signing secret                                            |
| `APP_URL`             | text       | where the API is served; Better Auth's base URL and passkey relying party |
| `WEB_ORIGINS`         | text       | comma-separated browser origins allowed with credentials; the first hosts `/device` |
| `OTP_DELIVERY`        | text       | `log` only, see above                                                   |

The application role is `studio_app` in every environment: `docker/init.sql` creates it locally, and the migration
`drizzle/0002_app_role_privileges.sql` grants it `select` on `user` and `update` of the profile columns. Umbrella
refuses to run request sessions on a connection that could bypass row-level security.

## Develop

```sh
pnpm install
pnpm --filter @conservationtv/studio-api db:up       # docker-compose Postgres on :5434, with both roles
pnpm --filter @conservationtv/studio-api db:migrate
cp .dev.vars.example .dev.vars                       # then set BETTER_AUTH_SECRET
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

Schema changes: edit `src/db/schema.ts`, then `pnpm db:generate` (drizzle-kit, then `umbrella generate` for the
access policies) and commit the migrations in `drizzle/`. Regenerate Better Auth's tables with `pnpm auth:generate`
after changing its plugins; the access definitions live in `schema.ts`, so regeneration never overwrites them.

Request handling reads its dependencies through `services()` (AsyncLocalStorage, `src/services.ts`). Only the
production Worker entrypoint constructs them; the database clients, the authorization client and Better Auth open on
first use within a request.

## Contracts, SDK and CLI

```sh
pnpm --filter @conservationtv/studio-api generate             # contracts/openapi.json from routes + handler types
pnpm --filter @conservationtv/studio-sdk generate
pnpm --filter @conservationtv/studio-cli generate
```

`pnpm snapshot studio-api-v1.0.0` freezes the current bundle under `contracts/snapshots/`, and `check:snapshot`,
`check:release` and `ci:contracts` gate releases, as for gatekeeper. No snapshot has been cut yet, so every contract
is still provisional.
