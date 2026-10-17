import { createPrivateKey } from 'node:crypto';
import * as cloudflare from '@pulumi/cloudflare';
import * as digitalocean from '@pulumi/digitalocean';
import * as planetscale from '@pulumi/planetscale';
import * as pulumi from '@pulumi/pulumi';
import * as random from '@pulumi/random';
import * as tls from '@pulumi/tls';
import {
  ANYWHERE,
  AcmeAccount,
  AcmeCertificate,
  DigitalOceanMachine,
  Fleet,
  renderSshConfig,
  type MachineCloudInit
} from '@moq-ha/vps-fleet';
import { MoqRelayCluster } from '@moq-ha/vps-fleet/moq';
import { IrohRelayCluster } from '@moq-ha/vps-fleet/iroh';

const config = new pulumi.Config();
const stack = pulumi.getStack();
const domain = config.require('domain');
const zoneId = config.require('zoneId');
const gatekeeperDomain = config.require('gatekeeperDomain');
const gatekeeperUrl = `https://${gatekeeperDomain}`;
// Account-wide names: prod keeps the bare `gatekeeper`, other stacks (staging) are suffixed with their name.
const gatekeeperName = stack === 'prod' ? 'gatekeeper' : `gatekeeper-${stack}`;
const accountId = cloudflare.getZoneOutput({ zoneId }).account.id;
// Relays are named by service and site: <service>.<site>.nodes.<domain>.
const site = 'ldn1';
const moqHostname = `moq.${site}.nodes.${domain}`;
const irohHostname = `iroh.${site}.nodes.${domain}`;

// SSH is key-only on a non-standard port, so it is open to wherever Pulumi runs (CI included).
const fleet = new Fleet('fleet', {
  namePrefix: 'controlplane',
  environment: stack,
  ssh: { port: 2222, allowedCidrs: [...ANYWHERE] }
});
// Without a registered key DigitalOcean emails a root password; access itself uses the key cloud-init installs.
const sshKey = new digitalocean.SshKey('bootstrap-ssh-key', {
  name: `controlplane-${stack}-bootstrap`,
  publicKey: fleet.publicKeyOpenSsh
});
const project = digitalocean.getProjectOutput({ name: 'conservationtv' });
// Both relays speak QUIC and ask for 8 MiB socket buffers; Ubuntu's default ceiling is 208 KiB.
const quicHost: MachineCloudInit = {
  files: [
    {
      path: '/etc/sysctl.d/60-quic-udp-buffers.conf',
      content: 'net.core.rmem_max = 8388608\nnet.core.wmem_max = 8388608\n'
    }
  ],
  commands: ['sysctl --system']
};
const moqMachine = new DigitalOceanMachine(`moq-${site}`, {
  fleet,
  region: 'lon1',
  hostname: moqHostname,
  sshKeys: [sshKey.id],
  project: project.id,
  cloudInit: quicHost
});
const irohMachine = new DigitalOceanMachine(`iroh-${site}`, {
  fleet,
  region: 'lon1',
  hostname: irohHostname,
  sshKeys: [sshKey.id],
  project: project.id,
  cloudInit: quicHost
});

const acme = new AcmeAccount('acme', {
  serverUrl: 'https://acme-v02.api.letsencrypt.org/directory',
  email: config.require('acmeEmail'),
  dnsChallenge: { provider: 'cloudflare' }
});
const moqCertificate = new AcmeCertificate('moq-relay-tls', { account: acme, names: [moqHostname] });
const irohCertificate = new AcmeCertificate('iroh-relay-tls', { account: acme, names: [irohHostname] });

const moqRelayToken = new random.RandomBytes('moq-relay-token', { length: 32 });
const moqClusterToken = new random.RandomBytes('moq-cluster-token', {
  length: 32,
  keepers: { generation: config.get('clusterTokenGeneration') ?? '1' }
});
const irohToken = new random.RandomBytes('iroh-token', { length: 32 });
// The environment's one consumer credential: whoever holds it may exchange grants for this stack's relays. To rotate,
// increment consumerTokenGeneration, release, and hand the new value to its holders; there is no overlap.
const consumerToken = new random.RandomBytes('consumer-token', {
  length: 32,
  keepers: { generation: config.get('consumerTokenGeneration') ?? '1' }
});

const moq = new MoqRelayCluster('moq-relay', {
  relays: [{ machine: moqMachine, hostname: moqHostname }],
  tls: moqCertificate,
  dns: { provider: 'cloudflare', zoneId },
  auth: { origin: gatekeeperUrl, token: moqRelayToken.hex, clusterToken: moqClusterToken.hex }
});
const iroh = new IrohRelayCluster('iroh-relay', {
  relays: [{ machine: irohMachine, hostname: irohHostname }],
  tls: irohCertificate,
  dns: { provider: 'cloudflare', zoneId },
  admission: { url: new URL('/relays/iroh/admission', gatekeeperUrl).href, token: irohToken.hex }
});

// Gatekeeper's Worker and the resources its versions bind. Versions are uploaded from gatekeeper's build; this stack
// routes traffic to the one tagged `gatekeeperVersion` once that is set.
const gatekeeperWorker = new cloudflare.Worker('gatekeeper', {
  accountId,
  name: gatekeeperName,
  observability: { enabled: true },
  subdomain: { enabled: false }
});
// Gatekeeper's PlanetScale Postgres database, next to the relays in London. Creating its main branch creates the
// database. PS-5, the default, runs as HA (a primary and two replicas): the provider cannot choose single-node.
const planetscaleOrganization = config.require('planetscaleOrganization');
const gatekeeperDatabase = new planetscale.PostgresBranch(
  'gatekeeper-database',
  {
    organization: planetscaleOrganization,
    database: gatekeeperName,
    name: 'main',
    region: 'aws-eu-west-2',
    clusterSize: config.get('databaseClusterSize') ?? 'PS_5_AWS_X86',
    deletionProtected: true
  },
  { protect: true }
);
const databaseRole = (name: string, inheritedRoles: string[]) =>
  new planetscale.PostgresBranchRole(`gatekeeper-database-${name}`, {
    organization: planetscaleOrganization,
    database: gatekeeperDatabase.database,
    branch: gatekeeperDatabase.name,
    name,
    inheritedRoles
  });
// The Worker reads and writes; migrations run as a separate role that can change the schema.
const gatekeeperAppRole = databaseRole('gatekeeper', ['pg_read_all_data', 'pg_write_all_data']);
const gatekeeperMigrationRole = databaseRole('gatekeeper_migrate', ['postgres']);

// Query caching is disabled: lease and revocation reads must be fresh.
const gatekeeperHyperdrive = new cloudflare.HyperdriveConfig('gatekeeper', {
  accountId,
  name: gatekeeperName,
  origin: {
    scheme: 'postgres',
    host: gatekeeperAppRole.accessHostUrl,
    port: 5432,
    database: gatekeeperAppRole.databaseName,
    user: gatekeeperAppRole.username,
    password: gatekeeperAppRole.password
  },
  caching: { disabled: true }
});

// The MoQ consumer token signing keys: an ES256 key per generation. Gatekeeper signs with the current generation's key
// and still verifies the previous generation's, so a rotation never invalidates live tokens. To rotate, increment
// moqSigningKeyGeneration and release; the previous key is dropped at the next rotation, so leave at least
// MAX_CREDENTIAL_LIFETIME_SECONDS between rotations.
const moqSigningKeyGeneration = Number(config.get('moqSigningKeyGeneration') ?? '1');
if (!Number.isInteger(moqSigningKeyGeneration) || moqSigningKeyGeneration < 1) {
  throw new Error('moqSigningKeyGeneration must be a positive integer');
}
const moqSigningKid = (generation: number) => `controlplane-moq-${generation}`;
const moqSigningKey = (generation: number) =>
  new tls.PrivateKey(`moq-signing-key-${generation}`, { algorithm: 'ECDSA', ecdsaCurve: 'P256' }).privateKeyPem.apply(
    pem => {
      const { kty, crv, x, y, d } = createPrivateKey(pem).export({ format: 'jwk' });
      return { kty, crv, alg: 'ES256', use: 'sig', kid: moqSigningKid(generation), x, y, d };
    }
  );
const moqSigningGenerations = [moqSigningKeyGeneration, moqSigningKeyGeneration - 1].filter(
  generation => generation >= 1
);
const moqSigningKeys = pulumi
  .all(moqSigningGenerations.map(moqSigningKey))
  .apply(keys => JSON.stringify({ active_kid: moqSigningKid(moqSigningKeyGeneration), keys }));

interface DeployedGatekeeper {
  versionTag?: string;
}

// The tag a version was uploaded with (`cf workers versions create --tag`), like an image tag. CI sets it for each
// release; otherwise this keeps the version deployed now, read from the stack's last outputs, so a plain `pulumi up`
// never rolls gatekeeper back or removes its deployment. Unset before the first upload, which needs the Worker and the
// bindings above to exist.
const previousOutputs = new pulumi.StackReference(`${pulumi.getOrganization()}/${pulumi.getProject()}/${stack}`);
// SAFETY: `gatekeeper` is this stack's own output, exported below with this shape (or absent before the first update).
const deployed = (await previousOutputs.getOutputDetails('gatekeeper')).value as DeployedGatekeeper | undefined;
const gatekeeperVersion = config.get('gatekeeperVersion') ?? deployed?.versionTag;
const gatekeeperVersionId = gatekeeperVersion
  ? cloudflare.getWorkerVersionsOutput({ accountId, workerId: gatekeeperWorker.name }).results.apply(versions => {
      // A tag can be uploaded more than once; the latest upload wins.
      const [latest] = versions
        .filter(v => v.annotations.workersTag === gatekeeperVersion)
        .sort((a, b) => b.number - a.number);
      if (!latest) throw new Error(`No gatekeeper version is tagged ${gatekeeperVersion}; upload it first`);
      return latest.id;
    })
  : undefined;
if (gatekeeperVersionId) {
  const deployment = new cloudflare.WorkersDeployment('gatekeeper', {
    accountId,
    scriptName: gatekeeperWorker.name,
    strategy: 'percentage',
    versions: [{ versionId: gatekeeperVersionId, percentage: 100 }],
    annotations: { workersMessage: `Deploy ${gatekeeperVersion}` }
  });
  // Cloudflare only attaches domains to a Worker that has a deployment.
  new cloudflare.WorkersCustomDomain(
    'gatekeeper',
    { accountId, zoneId, hostname: gatekeeperDomain, service: gatekeeperWorker.name },
    { dependsOn: deployment }
  );
  // Matches the trigger in gatekeeper's cloudflare.config.ts, which only local development applies.
  new cloudflare.WorkersCronTrigger(
    'gatekeeper',
    { accountId, scriptName: gatekeeperWorker.name, schedules: [{ cron: '*/15 * * * *' }] },
    { dependsOn: deployment }
  );
}

/** Gatekeeper's build settings, read from STACK_OUTPUT_JSON. */
export const gatekeeper = {
  workerName: gatekeeperName,
  versionTag: gatekeeperVersion,
  domain: gatekeeperDomain,
  hyperdriveId: gatekeeperHyperdrive.id,
  versionId: gatekeeperVersionId
};
/** Every gatekeeper secret binding, uploaded with each version through `--secrets-file`. */
export const gatekeeperSecrets = pulumi.secret({
  MOQ_SIGNING_KEYS: moqSigningKeys,
  MOQ_RELAY_TOKEN: moqRelayToken.hex,
  MOQ_CLUSTER_TOKEN: moqClusterToken.hex,
  IROH_RELAY_TOKEN: irohToken.hex,
  CONSUMER_TOKEN: consumerToken.hex
});
/** The consumer token, which the environment's consumers present as GATEKEEPER_TOKEN. */
export const gatekeeperConsumerToken = pulumi.secret(consumerToken.hex);
/** Gatekeeper's `DATABASE_URL` for `pnpm db:migrate`. */
export const gatekeeperMigrationUrl = pulumi
  .all([
    gatekeeperMigrationRole.username,
    gatekeeperMigrationRole.password,
    gatekeeperMigrationRole.accessHostUrl,
    gatekeeperMigrationRole.databaseName
  ])
  .apply(([user, password, host, database]) => {
    const url = new URL(`postgres://${host}:5432/${database}?sslmode=verify-full`);
    url.username = user;
    url.password = password;
    return pulumi.secret(url.href);
  });
export const moqDirectory = moq.directory;
export const irohDirectory = iroh.directory;
export const sshConfig = renderSshConfig([moqMachine, irohMachine], { aliasPrefix: `controlplane-${stack}` });
export const sshPrivateKey = fleet.privateKeyPem;
