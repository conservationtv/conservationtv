# Studio deployment

The [studio API](../api)'s Cloudflare Worker, its KV cache, its PlanetScale Postgres database with the two Hyperdrive
configs umbrella needs, and all of its secrets; and the [web app](../web)'s Worker. Both release like [gatekeeper](../../controlplane/infrastructure#release-gatekeeper):
versions are uploaded from their builds, and this stack routes traffic to one of each and owns their custom domains.

There are two stacks, `prod` (`studio.conservation.tv`, with the API on `api.studio.conservation.tv`) and `staging`
(`studio.staging.conservation.tv` and `api.studio.staging.conservation.tv`). Each
reads the [controlplane](../../controlplane/infrastructure) stack of the same name for its gatekeeper's URL and
consumer token, so that stack must be up first. Local development is docker compose; see the [API's README](../api/README.md#develop).

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
`metric_point_hypertable` migration creates the extension, which must be preloaded. The stack does not manage cluster
parameters, since setting any resets the rest to PlanetScale's defaults.

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
on a commit staging already runs. It uses the same GitHub environments and secrets as the controlplane workflow, and:

1. runs `pulumi up` without `apiVersion` or `webVersion`, applying infrastructure changes while keeping the deployed
   versions;
2. applies the API's migrations as `databaseMigrationUrl`;
3. makes the application role a member of `studio_app`;
4. uploads an API version tagged with the commit (`pnpm --filter @conservationtv/studio-api upload`), passing this
   stack's outputs as `STACK_OUTPUT_JSON` for the bindings and `apiSecrets` as the version's secrets;
5. builds the web app and uploads a web version tagged with the commit
   (`pnpm --filter @conservationtv/studio-web-worker upload`), passing this stack's outputs as `STACK_OUTPUT_JSON`;
6. runs `pulumi up --config apiVersion=<commit> --config webVersion=<commit>` to route traffic to both.

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
this stack: after rotating that, release the studio too. `BETTER_AUTH_SECRET` and `FIELD_KEY` are generated here. `FIELD_KEY` seals every
encrypted column and nothing re-seals them, so it is protected: replacing it loses that data.

## Not deployed yet

- **Sign-in codes.** `OTP_DELIVERY` is `log` only, so codes are written to the Worker's logs, readable by anyone with
  access to the Cloudflare account, and reach nobody else until an email provider is wired in.
