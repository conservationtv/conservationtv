import * as cloudflare from '@pulumi/cloudflare';
import * as planetscale from '@pulumi/planetscale';
import * as pulumi from '@pulumi/pulumi';
import * as random from '@pulumi/random';

const config = new pulumi.Config();
const stack = pulumi.getStack();
const zoneId = config.require('zoneId');
const apiDomain = config.require('apiDomain');
const appUrl = `https://${apiDomain}`;
const webDomain = config.require('webDomain');
// The web app's origin: the API trusts it, and hosts the device approval page there.
const webOrigin = `https://${webDomain}`;
// Account-wide names: prod keeps the bare names, other stacks (staging) are suffixed with their name.
const accountName = (name: string) => (stack === 'prod' ? name : `${name}-${stack}`);
const apiWorkerName = accountName('studio-api');
const webWorkerName = accountName('studio-web');
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
// SAFETY: the controlplane stack exports each consumer's token by namespace, and names this stack's consumer after it.
const gatekeeperTokens = controlplane.requireOutput('gatekeeperConsumerTokens') as pulumi.Output<
  Record<string, string>
>;
const gatekeeperToken = gatekeeperTokens.apply(tokens => {
  const token = tokens[stack];
  if (token === undefined) throw new Error(`The controlplane stack has no ${stack} consumer`);
  return token;
});

// The studio API's Worker and the resources its versions bind. Versions are uploaded from the API's build; this stack
// routes traffic to the one tagged `apiVersion` once that is set.
const apiWorker = new cloudflare.Worker('studio-api', {
  accountId,
  name: apiWorkerName,
  observability: { enabled: true },
  subdomain: { enabled: false }
});
// The web app's Worker. Its versions carry the app's build as static assets and serve the configuration it reads at
// runtime (`web` below) as /config.js; they are uploaded from ../web/worker, and deployed, like the API's.
const webWorker = new cloudflare.Worker('studio-web', {
  accountId,
  name: webWorkerName,
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

/** What this stack reads of its own `api` and `web` outputs. */
interface DeployedWorker {
  versionTag?: string;
}

// Each Worker's versions are uploaded with a tag (`cf workers versions create --tag`), like an image tag. CI sets
// `apiVersion` and `webVersion` for each release; otherwise this keeps the versions deployed now, read from the stack's
// last outputs, so a plain `pulumi up` never rolls either back or removes its deployment. Each is unset before its
// Worker's first upload, which needs the Worker and the bindings above to exist.
const previousOutputs = new pulumi.StackReference(`${pulumi.getOrganization()}/${pulumi.getProject()}/${stack}`);
const deployedTag = async (output: 'api' | 'web') =>
  // SAFETY: `api` and `web` are this stack's own outputs, exported below with this shape (or absent before the first
  // update).
  ((await previousOutputs.getOutputDetails(output)).value as DeployedWorker | undefined)?.versionTag;

/** Routes all of `worker`'s traffic to its version tagged `tag`, serves it on `hostname`, and returns the version's id. */
const deploy = (name: string, worker: cloudflare.Worker, hostname: string, tag: string) => {
  const versionId = cloudflare.getWorkerVersionsOutput({ accountId, workerId: worker.name }).results.apply(versions => {
    // A tag can be uploaded more than once; the latest upload wins.
    const [latest] = versions.filter(v => v.annotations.workersTag === tag).sort((a, b) => b.number - a.number);
    if (!latest) throw new Error(`No ${name} version is tagged ${tag}; upload it first`);
    return latest.id;
  });
  const deployment = new cloudflare.WorkersDeployment(name, {
    accountId,
    scriptName: worker.name,
    strategy: 'percentage',
    versions: [{ versionId, percentage: 100 }],
    annotations: { workersMessage: `Deploy ${tag}` }
  });
  // Cloudflare only attaches domains to a Worker that has a deployment.
  new cloudflare.WorkersCustomDomain(
    name,
    { accountId, zoneId, hostname, service: worker.name },
    { dependsOn: deployment }
  );
  return versionId;
};

const apiVersion = config.get('apiVersion') ?? (await deployedTag('api'));
const apiVersionId = apiVersion ? deploy('studio-api', apiWorker, apiDomain, apiVersion) : undefined;
const webVersion = config.get('webVersion') ?? (await deployedTag('web'));
const webVersionId = webVersion ? deploy('studio-web', webWorker, webDomain, webVersion) : undefined;

/** The studio API's build settings, read from STACK_OUTPUT_JSON. */
export const api = {
  workerName: apiWorkerName,
  versionTag: apiVersion,
  versionId: apiVersionId,
  adminHyperdriveId: adminHyperdrive.id,
  appHyperdriveId: appHyperdrive.id,
  cacheId: cache.id,
  appUrl,
  webOrigins: [webOrigin],
  gatekeeperUrl
};
/** The studio web Worker's build settings, read from STACK_OUTPUT_JSON: `apiUrl` is served to the app as /config.js. */
export const web = {
  workerName: webWorkerName,
  versionTag: webVersion,
  versionId: webVersionId,
  apiUrl: appUrl
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
