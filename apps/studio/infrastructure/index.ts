import * as cloudflare from '@pulumi/cloudflare';
import * as planetscale from '@pulumi/planetscale';
import * as pulumi from '@pulumi/pulumi';
import * as random from '@pulumi/random';

const config = new pulumi.Config();
const stack = pulumi.getStack();
const zoneId = config.require('zoneId');
const apiDomain = config.require('apiDomain');
const appUrl = `https://${apiDomain}`;
// Not served by this stack yet; the API trusts it as the web app's origin and hosts the device approval page there.
const webOrigin = `https://${config.require('webDomain')}`;
// Account-wide names: prod keeps the bare names, other stacks (staging) are suffixed with their name.
const accountName = (name: string) => (stack === 'prod' ? name : `${name}-${stack}`);
const workerName = accountName('studio-api');
const databaseName = accountName('studio');
const accountId = cloudflare.getZoneOutput({ zoneId }).account.id;

/** What this stack reads of the controlplane stack's `gatekeeper` output. */
interface ControlplaneGatekeeper {
  domain: string;
}

// The controlplane stack of the same name: its gatekeeper names the relays and admits devices to them, and trusts
// whoever holds its consumer token. Its `pulumi up` must have run first.
const controlplane = new pulumi.StackReference(`${pulumi.getOrganization()}/controlplane/${stack}`);
// SAFETY: the controlplane stack exports `gatekeeper` with its domain.
const controlplaneGatekeeper = controlplane.requireOutput('gatekeeper') as pulumi.Output<ControlplaneGatekeeper>;
const gatekeeperUrl = pulumi.interpolate`https://${controlplaneGatekeeper.domain}`;
const gatekeeperToken = controlplane.requireOutput('gatekeeperConsumerToken');

// The studio API's Worker and the resources its versions bind. Versions are uploaded from the API's build; this stack
// routes traffic to the one tagged `apiVersion` once that is set.
const apiWorker = new cloudflare.Worker('studio-api', {
  accountId,
  name: workerName,
  observability: { enabled: true },
  subdomain: { enabled: false }
});
const cache = new cloudflare.WorkersKvNamespace('studio-api-cache', {
  accountId,
  title: accountName('studio-api-cache')
});

// The studio's PlanetScale Postgres database in London, beside gatekeeper's. Creating its main branch creates the
// database. PS-5, the default, runs as HA (a primary and two replicas): the provider cannot choose single-node.
// TimescaleDB must be enabled in the cluster's configuration before the first migration; see the README.
const planetscaleOrganization = config.require('planetscaleOrganization');
const database = new planetscale.PostgresBranch(
  'studio-database',
  {
    organization: planetscaleOrganization,
    database: databaseName,
    name: 'main',
    region: 'aws-eu-west-2',
    clusterSize: config.get('databaseClusterSize') ?? 'PS_5_AWS_X86',
    deletionProtected: true
  },
  { protect: true }
);
const databaseRole = (name: string, inheritedRoles: string[]) =>
  new planetscale.PostgresBranchRole(`studio-database-${name}`, {
    organization: planetscaleOrganization,
    database: database.database,
    branch: database.name,
    name,
    inheritedRoles
  });
// Umbrella needs two roles. The owning role runs migrations, so it owns every table, and serves Better Auth and grants.
// Request sessions log in as the application role, which holds nothing of its own: after migrating, the release makes
// it a member of `studio_app`, which the migrations create and grant to, so row-level security applies to everything it
// does.
const adminRole = databaseRole('studio', ['postgres']);
const appRole = databaseRole('studio_app', []);

// Query caching is disabled: request sessions read under row-level security, and grants must take effect at once.
const hyperdrive = (name: string, role: planetscale.PostgresBranchRole) =>
  new cloudflare.HyperdriveConfig(`studio-api-${name}`, {
    accountId,
    name: accountName(`studio-api-${name}`),
    origin: {
      scheme: 'postgres',
      host: role.accessHostUrl,
      port: 5432,
      database: role.databaseName,
      user: role.username,
      password: role.password
    },
    caching: { disabled: true }
  });
const adminHyperdrive = hyperdrive('admin', adminRole);
const appHyperdrive = hyperdrive('app', appRole);

const betterAuthSecret = new random.RandomBytes('better-auth-secret', { length: 32 });
// Every encrypted column is sealed under this key, and nothing re-seals them yet: replacing it loses that data.
const fieldKey = new random.RandomBytes('field-key', { length: 32 }, { protect: true });

interface DeployedApi {
  versionTag?: string;
}

// The tag a version was uploaded with (`cf workers versions create --tag`), like an image tag. CI sets it for each
// release; otherwise this keeps the version deployed now, read from the stack's last outputs, so a plain `pulumi up`
// never rolls the API back or removes its deployment. Unset before the first upload, which needs the Worker and the
// bindings above to exist.
const previousOutputs = new pulumi.StackReference(`${pulumi.getOrganization()}/${pulumi.getProject()}/${stack}`);
// SAFETY: `api` is this stack's own output, exported below with this shape (or absent before the first update).
const deployed = (await previousOutputs.getOutputDetails('api')).value as DeployedApi | undefined;
const apiVersion = config.get('apiVersion') ?? deployed?.versionTag;
const apiVersionId = apiVersion
  ? cloudflare.getWorkerVersionsOutput({ accountId, workerId: apiWorker.name }).results.apply(versions => {
      // A tag can be uploaded more than once; the latest upload wins.
      const [latest] = versions
        .filter(v => v.annotations.workersTag === apiVersion)
        .sort((a, b) => b.number - a.number);
      if (!latest) throw new Error(`No studio API version is tagged ${apiVersion}; upload it first`);
      return latest.id;
    })
  : undefined;
if (apiVersionId) {
  const deployment = new cloudflare.WorkersDeployment('studio-api', {
    accountId,
    scriptName: apiWorker.name,
    strategy: 'percentage',
    versions: [{ versionId: apiVersionId, percentage: 100 }],
    annotations: { workersMessage: `Deploy ${apiVersion}` }
  });
  // Cloudflare only attaches domains to a Worker that has a deployment.
  new cloudflare.WorkersCustomDomain(
    'studio-api',
    { accountId, zoneId, hostname: apiDomain, service: apiWorker.name },
    { dependsOn: deployment }
  );
}

/** The studio API's build settings, read from STACK_OUTPUT_JSON. */
export const api = {
  workerName,
  versionTag: apiVersion,
  versionId: apiVersionId,
  adminHyperdriveId: adminHyperdrive.id,
  appHyperdriveId: appHyperdrive.id,
  cacheId: cache.id,
  appUrl,
  webOrigins: [webOrigin],
  gatekeeperUrl
};
/** Every studio API secret binding, uploaded with each version through `--secrets-file`. */
export const apiSecrets = pulumi.secret({
  BETTER_AUTH_SECRET: betterAuthSecret.base64,
  FIELD_KEY: fieldKey.base64,
  GATEKEEPER_TOKEN: gatekeeperToken
});
/** The PostgreSQL role the application role logs in as, which the release makes a member of `studio_app`. */
export const databaseAppRole = appRole.baseUsername;
/** The owning role's `DATABASE_URL`, for `pnpm db:migrate` and making the application role a member of `studio_app`. */
export const databaseMigrationUrl = pulumi
  .all([adminRole.username, adminRole.password, adminRole.accessHostUrl, adminRole.databaseName])
  .apply(([user, password, host, database]) => {
    const url = new URL(`postgres://${host}:5432/${database}?sslmode=verify-full`);
    url.username = user;
    url.password = password;
    return pulumi.secret(url.href);
  });
