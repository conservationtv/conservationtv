# Studio deployment

The [studio API](../api)'s Cloudflare Worker, its KV cache, its PlanetScale Postgres database with the two Hyperdrive
configs umbrella needs, and all of its secrets. The API releases like [gatekeeper](../../controlplane/infrastructure#release-gatekeeper):
versions are uploaded from its build, and this stack routes traffic to one and owns its custom domain. The web app is
not deployed by this stack yet; `webDomain` only names the origin the API trusts and sends people to for device approval.

There are two stacks, `prod` (`api.studio.conservation.tv`) and `staging` (`api.studio.staging.conservation.tv`). Each
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

Account-wide names (the Worker, its KV namespace, database and Hyperdrive configs) are bare for prod and suffixed with
`-<stack>` otherwise. The database is `studio` in `aws-eu-west-2` on `PS_5_AWS_X86` (`databaseClusterSize` overrides it),
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
the API, this stack or the packages the API bundles; `prod` is released by hand (`gh workflow run studio -f stack=prod`)
on a commit staging already runs. It uses the same GitHub environments and secrets as the controlplane workflow, and:

1. runs `pulumi up` without `apiVersion`, applying infrastructure changes while keeping the deployed version;
2. applies the API's migrations as `databaseMigrationUrl`;
3. makes the application role a member of `studio_app`;
4. uploads a version tagged with the commit (`pnpm --filter @conservationtv/studio-api upload`), passing this stack's
   outputs as `STACK_OUTPUT_JSON` for the bindings and `apiSecrets` as the version's secrets;
5. runs `pulumi up --config apiVersion=<commit>` to route traffic to it.

`apiVersion` is not kept in the stack files. When it is unset, the stack keeps the tag deployed now, read from its own
last outputs, so a `pulumi up` from a workstation never rolls the API back. To roll back,
`pulumi up --config apiVersion=<earlier commit>`.

Secrets reach the API only with a release. `GATEKEEPER_TOKEN` is the controlplane stack's consumer token: after
rotating that, release the studio too. `BETTER_AUTH_SECRET` and `FIELD_KEY` are generated here. `FIELD_KEY` seals every
encrypted column and nothing re-seals them, so it is protected: replacing it loses that data.

## Not deployed yet

- **The web app.** It is a static single-page app (`../web`, `ssr: false`) built with `VITE_API_URL` set to the API's
  URL, to be served on `webDomain`, for example by a Worker with static assets and single-page-application not-found
  handling.
- **Sign-in codes.** `OTP_DELIVERY` is `log` only, so codes are written to the Worker's logs, readable by anyone with
  access to the Cloudflare account, and reach nobody else until an email provider is wired in.
