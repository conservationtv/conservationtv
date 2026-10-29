# Studio deployment

The [studio API](../api)'s Cloudflare Worker, its KV cache, its PlanetScale Postgres database with the two Hyperdrive
configs umbrella needs, and all of its secrets; and the [web app](../web)'s Worker. Both release like [gatekeeper](../../controlplane/infrastructure#release-gatekeeper):
versions are uploaded from their builds, and this stack routes traffic to one of each and owns their custom domains.

There are three stacks: `prod` (`studio.conservation.tv`, with the API on `api.studio.conservation.tv`), `staging`
(`studio.staging.conservation.tv` and `api.studio.staging.conservation.tv`), and `preview`
(`studio.preview.conservation.tv` and `api.studio.preview.conservation.tv`), a clone of staging that runs one pull
request at a time (see [Preview](#preview)). Each reads the [controlplane](../../controlplane/infrastructure) stack of
the same name (the preview, staging's) for its gatekeeper's URL and its consumer's token, so that stack must be up first. Local development is docker compose; see the [API's README](../api/README.md#develop).

## Configure and deploy

From the repository root:

```sh
pnpm install
pnpm --filter @conservationtv/studio-infrastructure build
cd apps/studio/infrastructure
```

Use the repository's [Pulumi credentials workflow](../../../docs/infra/pulumi.md): from this directory, the wrapper is
`op run --env-file=../../../.env.pulumi -- pulumi …`. The checked-in stack files hold `zoneId`, `apiDomain`, `webDomain`
and `planetscaleOrganization`; the first `pulumi stack init <stack>` adds the stack's encryption salt.

The tokens are the controlplane stack's (see [its README](../../controlplane/infrastructure/README.md#configure-and-deploy)).
The Cloudflare token additionally needs `Workers KV Storage Write` on the account. The PlanetScale token may create
databases, and has full access to those it creates, so it controls the studio databases (`studio`, `studio-staging`) too.

Account-wide names (the Workers, the API's KV namespace, database and Hyperdrive configs) are bare for prod and suffixed
with `-<stack>` otherwise. The database is `studio` in `aws-eu-west-2` on `PS_5_AWS_X86` (`databaseClusterSize` overrides it),
HA as gatekeeper's is, protected in Pulumi and deletion-protected in PlanetScale.

Before the first release, enable TimescaleDB in each database's cluster configuration in PlanetScale: the
`metric_point_hypertable` migration creates the extension, which must be preloaded. The stack does not manage their cluster
parameters, since setting any resets the rest to PlanetScale's defaults (a clone's are the exception; see
[Preview](#preview)). Each release checks that TimescaleDB is preloaded.

### Database roles

Umbrella runs request sessions as a role that cannot bypass row-level security. The API's migrations create that role,
`studio_app`, without login, and grant it its privileges. PlanetScale names the login roles it creates (`pscale_api_…`;
a role's `name` is only a label), so:

- `studio` inherits `postgres` and owns the schema: migrations run as it (`databaseMigrationUrl`), and it is
  `HYPERDRIVE_ADMIN`.
- `studio_app` inherits nothing. Each release, after migrating, makes its login role (`databaseAppRole`) a member of
  `studio_app`, so it holds exactly what the migrations grant. It is `HYPERDRIVE_APP`.

Both Hyperdrive configs disable query caching: request sessions read under row-level security, and grant changes must
apply at once.

## Release

The [`studio` workflow](../../../.github/workflows/studio.yml) releases `staging` on every push to `main` that touches
the API, the web app, this stack or the packages either bundles; `prod` is released by hand (`gh workflow run studio -f stack=prod`)
on a commit staging already runs. Both, and the preview, run the [`studio-release` workflow](../../../.github/workflows/studio-release.yml),
in the GitHub environment named after the stack, with the same secrets as the controlplane workflow. It:

1. runs `pulumi up` without `apiVersion` or `webVersion`, applying infrastructure changes while keeping the deployed
   versions;
2. checks that the database preloads TimescaleDB, and that the commit has every migration the database has applied
   (drizzle-kit ignores records it has no migration for, so a commit behind them would migrate a schema it has not
   seen);
3. applies the API's migrations as `databaseMigrationUrl`;
4. makes the application role a member of `studio_app`;
5. uploads an API version tagged with the commit (`pnpm --filter @conservationtv/studio-api upload`), passing this
   stack's outputs as `STACK_OUTPUT_JSON` for the bindings and `apiSecrets` as the version's secrets;
6. builds the web app and uploads a web version tagged with the commit
   (`pnpm --filter @conservationtv/studio-web-worker upload`), passing this stack's outputs as `STACK_OUTPUT_JSON`;
7. runs `pulumi up --config apiVersion=<commit> --config webVersion=<commit>` to route traffic to both.

`apiVersion` and `webVersion` are not kept in the stack files. When one is unset, the stack keeps the tag deployed now,
read from its own last outputs, so a `pulumi up` from a workstation never rolls either back. To roll one back,
`pulumi up --config apiVersion=<earlier commit>` (or `webVersion`).

### The web app's configuration

The web app's build is the same for every stack. Its Worker ([`../web/worker`](../web/worker)) serves the build as
static assets, answering unknown paths with `index.html`, and serves the stack's configuration for it as `/config.js`,
which the document loads before the app (see `src/lib/config.ts` there). That configuration is the `web` output, bound
to each version as text, so it changes only with a release and rolls back with one. In development, the web app's
Vite server answers `/config.js` instead, from `API_URL` in the environment or the local API.

Secrets reach the API only with a release. `GATEKEEPER_TOKEN` is the token of the controlplane stack's consumer named after
this stack: after rotating that, release the studio too. `BETTER_AUTH_SECRET` and `FIELD_KEY` are generated here (a clone takes its source's). `FIELD_KEY` seals every
encrypted column and nothing re-seals them, so it is protected: replacing it loses that data.

## Preview

The `preview` stack sets `cloneOf: staging`. A clone shares staging's controlplane, and staging's `BETTER_AUTH_SECRET`
and `FIELD_KEY` (read from its `apiSecrets`, so staging must be up first): its data is staging's, sealed under that key.
Its Workers, KV cache, Hyperdrive configs and database roles are its own. Its database is the `preview` branch of
`studio-staging`, a single-node `PS_DEV_AWS_X86` development branch restored from staging's `main` as of `restorePoint`;
a new restore point replaces the branch, its roles with it. The restore does not carry staging's cluster parameters, so
the stack sets `shared_preload_libraries` to `timescaledb` on the branch (which resets the rest to PlanetScale's
defaults; nothing else is set on a clone).

The [`studio-preview` workflow](../../../.github/workflows/studio-preview.yml) releases one pull request to it:
`gh workflow run studio-preview -f pr=<number> -f sha=<head commit>`. It restores the branch as of six minutes ago
(PlanetScale's latest is five), so the preview starts from staging's data as it was then, migrates it with the pull
request's migrations, and releases the pull request's head as the other stacks release theirs; then it comments on the
pull request. A pull request must be up to date with `main` (the check above), must be open, and must be from this
repository, not a fork: the release runs its code with the `preview` environment's secrets. For the same reason only a
maintainer (the repository's maintain or admin role, the roles that can merge into `main`) may dispatch it, naming the
head they vouch for (the run refuses if the head has moved since, even while it waited behind another preview), and the
`preview` environment, like `staging` and `prod`, admits only `main`'s workflows, so a branch cannot release with an
edited copy. Each preview replaces the last, whichever pull request it was for; a restore takes about two minutes.

Sign in with your staging account by code (written to `studio-api-preview`'s logs for now; see [Not deployed yet](#not-deployed-yet)): passkeys are bound to the web app's host, so staging's do not work
on the preview. The preview is staging's gatekeeper's `preview` consumer, so its MoQ roots never meet staging's, but
the agents and devices in its data are staging's real ones.

Like `apiVersion`, `restorePoint` is not kept in the stack file: unset, the stack keeps the point restored now, so a
plain `pulumi up` never restores again.

## Not deployed yet

- **Sign-in codes.** `OTP_DELIVERY` is `log` only, so codes are written to the Worker's logs, readable by anyone with
  access to the Cloudflare account, and reach nobody else until an email provider is wired in.
