# Controlplane deploy log — 2026-10-12

Deploying the `prod` controlplane stack and releasing gatekeeper. Pulumi commands run from
`apps/controlplane/infrastructure` under `op run --account my.1password.eu --env-file=../../../.env.pulumi --`,
abbreviated below as `op run … --`. Secret values are never logged.

## 1. Check the Pulumi backend and stack

**Reason:** confirm the self-hosted backend is reachable and see what `prod` already contains before changing it.

```sh
op run … -- pulumi whoami -v
op run … -- pulumi stack ls
op run … -- pulumi stack history --stack prod
op run … -- pulumi config --stack prod
```

**Result:** logged in to the Postgres backend. `prod` exists with 0 resources; its latest update (2 hours ago) was a
`destroy` of 45 resources. This is a fresh deploy with nothing to import. Config has `domain`, `zoneId`, `acmeEmail`,
`gatekeeperDomain`, `planetscaleOrganization` and both provider tokens; `moqSigningKids` and `moqSigningActiveKid` are
missing.

## 2. Set the MoQ signing key config

**Reason:** the stack now generates gatekeeper's ES256 signing keys and requires the kid list and active kid.

```sh
op run … -- pulumi config set --stack prod --path 'moqSigningKids[0]' controlplane-moq-2026-10-12
op run … -- pulumi config set --stack prod moqSigningActiveKid controlplane-moq-2026-10-12
```

**Result:** `moqSigningKids = ["controlplane-moq-2026-10-12"]`, `moqSigningActiveKid = controlplane-moq-2026-10-12`,
saved to `Pulumi.prod.yaml`.

## 3. Build the stack program

**Reason:** the Pulumi project runs the compiled `bin/index.js` (`typescript: false`), which must include the fleet
package and the latest `index.ts`.

```sh
pnpm --filter @conservationtv/controlplane-infrastructure build
```

**Result:** fleet package and `bin/index.js` built without errors.

## 4. Preview

**Reason:** see exactly what will be created before applying anything.

```sh
op run … -- pulumi preview --stack prod --non-interactive --diff=false
```

**Result:** 51 resources to create, nothing to update or delete. Includes both droplets and their firewalls, ACME
certificates, relay DNS records and Compose deployments; the `gatekeeper` Worker, Hyperdrive config and signing key;
the PlanetScale `gatekeeper` database (`main` branch) and its `gatekeeper` and `gatekeeper_migrate` roles. No
`WorkersDeployment`, custom domain or cron trigger, as `gatekeeperVersion` is not set yet.

## 5. Apply (first attempt)

**Reason:** create the stack's resources.

```sh
op run … -- pulumi up --stack prod --yes --non-interactive --skip-preview --diff=false
```

**Result:** failed after 20s with 3 errors (the Worker, the PlanetScale branch and the stack). Only free resources
were created: generated tokens and keys, the ACME account registration, and the component and provider resources (30
in state). No droplets, DNS records, Cloudflare resources or database exist. Errors:

- `cloudflare:index:Worker gatekeeper`: `403 Forbidden, Authentication error` creating the Worker.
- `planetscale:index:PostgresBranch gatekeeper-database`: `HTTP 422: Cluster size is invalid.`

## 6. Diagnose the Cloudflare 403

**Reason:** find what the stack's Cloudflare token is allowed to do.

```sh
op run … -- sh -c 'curl -H "Authorization: Bearer $(pulumi config get cloudflare:apiToken)" …/user/tokens/verify'
cf user tokens get b45e10d4b00146924a5202d565284ca5
```

**Result:** the token is "pulumi controlplane dev (conservation.tv DNS)" (`b45e10d4…`), with only `Zone Read` and
`DNS Write` on the conservation.tv zone. The stack now also needs account-level `Workers Scripts Write` and
`Hyperdrive Write`, and zone-level `Workers Routes Write` for the custom domain. The zone's account is
`0def86f295b15a1a2d012774b38b04f9`.

## 7. Diagnose the PlanetScale 422

**Reason:** `PS_5_AWS_ARM` was expected to be valid; find why the API rejects it.

```sh
pscale api organizations/conservationtv/cluster-size-skus -Q engine=postgresql -Q region=aws-eu-west-2 -Q rates=true
op run … -- curl -H "Authorization: $PLANETSCALE_SERVICE_TOKEN_ID:…" …/cluster-size-skus?engine=postgresql&region=aws-eu-west-2
op run … -- env TF_LOG=DEBUG pulumi up --stack prod --target '<gatekeeper-database URN>' …   # debug log deleted after
```

**Result:** `PS_5_AWS_ARM` is listed as enabled and production for the org, for both the user and the service token.
The provider's request body is as configured: `{"cluster_size":"PS_5_AWS_ARM","create_database_if_missing":true,
"deletion_protected":true,"kind":"postgresql","name":"main","region":"aws-eu-west-2"}`. The API still answers
`422 Cluster size is invalid`. No provider issue mentions this error. Root cause not yet confirmed; the create-branch
API documents cluster sizes from `PS_10` upwards, so creating a database through a branch may not accept PS-5.

## 8. Grant the Cloudflare token Workers and Hyperdrive access (failed)

**Reason:** fix the 403 by adding `Workers Scripts Write` and `Hyperdrive Write` on account `0def86f2…` and
`Workers Routes Write` on the zone to token `b45e10d4…`, keeping its existing `Zone Read` and `DNS Write`.

```sh
cf user tokens permission-groups list
cf user tokens update b45e10d4b00146924a5202d565284ca5 --body '<existing zone policy + Workers Routes Write; account policy>' --dry-run
cf user tokens update b45e10d4b00146924a5202d565284ca5 --body '…'
```

**Result:** the dry run produced the intended request, but the update returned `403 [9109] Unauthorized to access
requested resource`: the `cf` OAuth login can read API tokens but not edit them. The token is unchanged; it needs to
be edited in the Cloudflare dashboard.

## 9. Switch the database to `PS_5_AWS_X86`

**Reason:** PS-5 appears to be offered only on x86 in London (the existing `pulumi` database there is
`PS_5_AWS_X86`); the SKU list reports `PS_5_AWS_ARM` as enabled without reflecting regional availability.

```sh
sed -i '' "s/clusterSize: 'PS_5_AWS_ARM'/clusterSize: 'PS_5_AWS_X86'/" index.ts   # and the README
pnpm --filter @conservationtv/controlplane-infrastructure build
```

**Result:** program rebuilt with `PS_5_AWS_X86`.

## 10. Create only the PlanetScale resources (interrupted)

**Reason:** create the database and its roles while the Cloudflare token is still blocked.

```sh
op run … -- pulumi up --stack prod --yes --non-interactive --skip-preview --diff=false \
  --target '<gatekeeper-database URN>' --target '<gatekeeper role URN>' --target '<gatekeeper_migrate role URN>'
```

**Result:** PlanetScale accepted `PS_5_AWS_X86`: database `gatekeeper` was created (branch `main`, id `k48tpq1h9btz`,
2 replicas, i.e. HA) and became ready a few minutes later. The update itself was cancelled after 2m7s: the program
crashed in the fleet package (`packages/fleet/src/core/compose/lifecycle.ts:223`, `Buffer.from(undefined)`) because,
in a targeted update on a partly created stack, outputs of resources that do not exist yet are `undefined`. The stack
was left with a pending create for `gatekeeper-database` and no ID. Orphaned provider processes from the cancelled
runs were stopped afterwards. Roles were not created.

## 11. Adopt the created database into the stack (blocked)

**Reason:** record the real database against the pending create rather than creating it again.

```sh
op run … -- pulumi refresh --stack prod --yes --non-interactive --skip-preview \
  --import-pending-creates '<gatekeeper-database URN>' --import-pending-creates k48tpq1h9btz
```

**Result:** the first attempt passed URN and ID as one comma-separated value, which Pulumi rejects ("each URN must be
followed by an ID"). The corrected command did not run: the 1Password authorization prompt was dismissed.

## 12. Create a new Cloudflare token for the stack

**Reason:** the existing token could not be edited, so create a replacement with the permissions the stack needs and
make it the stack's `cloudflare:apiToken`. The value is piped straight into Pulumi's encrypted config, never printed;
if storing fails, the new token is deleted.

```sh
cf accounts tokens create --name 'pulumi controlplane prod (conservation.tv)' --policies '<policies>'   # tried first
cf user tokens create --name 'pulumi controlplane prod (conservation.tv)' --policies '<policies>'
… | op run … -- pulumi config set --secret cloudflare:apiToken --stack prod
```

Policies: zone conservation.tv: `Zone Read`, `DNS Write`, `Workers Routes Write`; account `0def86f2…`:
`Workers Scripts Write`, `Hyperdrive Write`.

**Result:** an account-owned token was refused (`403 [9109]`); a user token was created, `59c1af19…`, and stored as
the stack's `cloudflare:apiToken`. Verified with the token: `user/tokens/verify`, listing Workers scripts, listing
Hyperdrive configs and listing zone DNS records all succeed. The previous token `b45e10d4…` ("pulumi controlplane
dev (conservation.tv DNS)") is no longer used by the stack and still exists.

## 13. Adopt the created database into the stack

**Reason:** the interrupted update left a pending create; record the real database instead of creating it again.

```sh
op run … -- pulumi refresh --stack prod --yes --non-interactive --skip-preview \
  --import-pending-creates '<gatekeeper-database URN>' --import-pending-creates k48tpq1h9btz
op run … -- pulumi import planetscale:index/postgresBranch:PostgresBranch gatekeeper-database \
  '{"database":"gatekeeper","id":"k48tpq1h9btz","organization":"conservationtv"}' --stack prod --protect --generate-code=false
```

**Result:** the refresh cleared the pending create but did not record the branch (the provider's read needs its JSON
import ID, not the bare branch ID). `pulumi import` with the JSON ID then imported it, protected. 26 resources in state.

## 14. Preview the full apply

**Reason:** confirm the imported database matches the program and see what remains.

```sh
op run … -- pulumi preview --stack prod --non-interactive --diff
```

**Result:** the database branch has no diff; 25 resources to create, 26 unchanged, nothing to update, replace or delete.

## 15. Apply the full stack

**Reason:** create the remaining resources now that the token and database are fixed.

```sh
op run … -- pulumi up --stack prod --yes --non-interactive --skip-preview --diff=false
```

**Result:** succeeded in 3m28s: 25 created, 26 unchanged. Outputs: `gatekeeper.hyperdriveId = 8cfa50f7ee3846c098db9c9f14e077d0`;
MoQ relay `moq.ldn1.nodes.conservation.tv` at `144.126.195.117`; Iroh relay `iroh.ldn1.nodes.conservation.tv` at
`143.110.174.101`.

## 16. Check the relays

**Reason:** confirm DNS, TLS and the relay processes work end to end.

```sh
dig +short moq.ldn1.nodes.conservation.tv; dig +short iroh.ldn1.nodes.conservation.tv
curl https://moq.ldn1.nodes.conservation.tv/health
curl https://iroh.ldn1.nodes.conservation.tv/
```

**Result:** both names resolve to their droplets and serve valid Let's Encrypt certificates. MoQ `/health` returns
`200 ok`; the Iroh relay returns `200`. Relay admission depends on gatekeeper, which is not deployed yet.

## 17. Commit for the release

**Reason:** `release.sh` tags the uploaded version with the commit and refuses to run with uncommitted changes.

```sh
git add -A && git commit -m 'controlplane: deploy gatekeeper from Pulumi with a PlanetScale database'
```

**Result:** `d65fe2ea4f40de5d42f861966b201b425d2b240f` on `main` (not pushed).

## 18. Release gatekeeper (partly failed)

**Reason:** migrate the database, upload the version and deploy it.

```sh
op run --no-masking … -- env CLOUDFLARE_ACCOUNT_ID=0def86f295b15a1a2d012774b38b04f9 apps/controlplane/release.sh prod
```

`--no-masking` because `op run` masks the string `postgres` in output; `CLOUDFLARE_ACCOUNT_ID` because the `cf` login
sees several accounts.

**Result:**

- Migrations applied as `gatekeeper_migrate`. Checked afterwards with
  `PGSSLROOTCERT=system psql "$(pulumi stack output gatekeeperMigrationUrl --show-secrets)" -c '<list tables>'`:
  `public.assertion_replays`, `public.grants`, `public.iroh_leases`, `public.jwks_cache` and
  `drizzle.__drizzle_migrations` exist.
- Version `0e5ec55a-d219-4b0c-bbff-e1197702c6ca` uploaded, tagged `d65fe2ea…`, with the Hyperdrive binding
  `8cfa50f7…`, the three text bindings and the four secrets. The upload did not touch domains or cron triggers.
- The final `pulumi up` failed: `--yes or --skip-preview or --preview-only must be passed in to proceed when running in
  non-interactive mode`.

## 19. Fix `release.sh` and deploy the uploaded version (partly failed)

**Reason:** `release.sh` needs `--yes` on its `pulumi up`; deploy the version that was already uploaded.

```sh
sed -i '' 's|up --stack "$stack" --config|up --stack "$stack" --yes --config|' apps/controlplane/release.sh
op run --no-masking … -- pulumi up --stack prod --yes --non-interactive --config gatekeeperVersion=d65fe2e8f8d5d07b4cb31e43d7e6b17da6f0d1f5
op run --no-masking … -- pulumi up --stack prod --yes --non-interactive --config gatekeeperVersion=$(git rev-parse d65fe2e)
```

**Result:** the first attempt used a mistyped full hash (`d65fe2e8f8d5…`, not the commit's) and failed with "No
gatekeeper version is tagged …" before creating anything. With the real hash, the `WorkersDeployment` (100% to
`0e5ec55a…`) and the cron trigger were created, but the custom domain failed:
`400 [100124] Cannot attach custom domain: Worker 'gatekeeper' has no deployments`, because Pulumi created it in
parallel with the deployment. `gatekeeperVersion` is now saved in `Pulumi.prod.yaml`.

## 20. Order the domain and cron trigger after the deployment

**Reason:** make the custom domain (and the cron trigger) wait for the deployment so a fresh stack does not race.

```sh
# index.ts: WorkersCustomDomain and WorkersCronTrigger get { dependsOn: deployment }
pnpm --filter @conservationtv/controlplane-infrastructure build
op run --no-masking … -- pulumi up --stack prod --yes --non-interactive
```

**Result:** 1 created (the custom domain), 53 unchanged. `gatekeeper.conservation.tv` is attached to `gatekeeper` and
enabled.

## 21. Check gatekeeper

**Reason:** confirm the Worker serves on its domain.

```sh
dig +short gatekeeper.conservation.tv @1.1.1.1
curl --doh-url https://1.1.1.1/dns-query https://gatekeeper.conservation.tv/health
curl --doh-url https://1.1.1.1/dns-query -X POST https://gatekeeper.conservation.tv/relays/iroh/admission
```

**Result:** resolves to Cloudflare (`104.21.7.110`, `172.67.130.34`); the local resolver had cached the name as
missing, hence DNS-over-HTTPS. `/health` returns `200 {"status":"ok"}`; relay admission without credentials returns
`401`. `/health` does not query the database, so the Hyperdrive-to-PlanetScale path is not yet exercised by a request.

## Outcome

Deployed: both relays, the gatekeeper Worker on `gatekeeper.conservation.tv` (version `0e5ec55a…`), Hyperdrive, the
cron trigger and the PlanetScale `gatekeeper` database (HA `PS_5_AWS_X86`) with migrations applied. Follow-ups:

- The fleet package crashes in targeted updates on a partly created stack
  (`packages/fleet/src/core/compose/lifecycle.ts:223`).
- The old Cloudflare token `b45e10d4…` is unused and can be deleted.
- Database connectivity through Hyperdrive is unverified until a request or the 15-minute cron touches it.
