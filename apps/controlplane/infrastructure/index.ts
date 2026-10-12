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
  dnsChallenge: { provider: 'cloudflare', apiToken: new pulumi.Config('cloudflare').requireSecret('apiToken') }
});
const moqCertificate = new AcmeCertificate('moq-relay-tls', { account: acme, names: [moqHostname] });
const irohCertificate = new AcmeCertificate('iroh-relay-tls', { account: acme, names: [irohHostname] });

const moqRelayToken = new random.RandomBytes('moq-relay-token', { length: 32 });
const moqClusterToken = new random.RandomBytes('moq-cluster-token', {
  length: 32,
  keepers: { generation: config.get('clusterTokenGeneration') ?? '1' }
});
const irohToken = new random.RandomBytes('iroh-token', { length: 32 });

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
  name: 'gatekeeper',
  observability: { enabled: true },
  subdomain: { enabled: false }
});
// Gatekeeper's PlanetScale Postgres database, next to the relays in London. Creating its main branch creates the
// database. PS-5 runs as HA (a primary and two replicas): the provider cannot choose single-node.
const planetscaleOrganization = config.require('planetscaleOrganization');
const gatekeeperDatabase = new planetscale.PostgresBranch(
  'gatekeeper-database',
  {
    organization: planetscaleOrganization,
    database: 'gatekeeper',
    name: 'main',
    region: 'aws-eu-west-2',
    clusterSize: 'PS_5_AWS_X86',
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
  name: 'gatekeeper',
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

// The MoQ consumer token signing keys, one ES256 key per kid. To rotate: add a kid and release, switch
// moqSigningActiveKid and release, then remove the old kid once its longest-lived token has expired.
const moqSigningKids = config.requireObject<string[]>('moqSigningKids');
const moqSigningActiveKid = config.require('moqSigningActiveKid');
if (!moqSigningKids.includes(moqSigningActiveKid))
  throw new Error('moqSigningActiveKid must name one of moqSigningKids');
const moqSigningKeys = pulumi
  .all(
    moqSigningKids.map(kid =>
      new tls.PrivateKey(`moq-signing-key-${kid}`, { algorithm: 'ECDSA', ecdsaCurve: 'P256' }).privateKeyPem.apply(
        pem => {
          const { kty, crv, x, y, d } = createPrivateKey(pem).export({ format: 'jwk' });
          return { kty, crv, alg: 'ES256', use: 'sig', kid, x, y, d };
        }
      )
    )
  )
  .apply(keys => JSON.stringify({ active_kid: moqSigningActiveKid, keys }));

// The tag a version was uploaded with (`cf workers versions create --tag`), like an image tag. Unset until the first
// upload, which needs the Worker and the bindings above to exist.
const gatekeeperVersion = config.get('gatekeeperVersion');
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
  new cloudflare.WorkersDeployment('gatekeeper', {
    accountId,
    scriptName: gatekeeperWorker.name,
    strategy: 'percentage',
    versions: [{ versionId: gatekeeperVersionId, percentage: 100 }],
    annotations: { workersMessage: `Deploy ${gatekeeperVersion}` }
  });
  new cloudflare.WorkersCustomDomain('gatekeeper', {
    accountId,
    zoneId,
    hostname: gatekeeperDomain,
    service: gatekeeperWorker.name
  });
  // Matches the trigger in gatekeeper's cloudflare.config.ts, which only local development applies.
  new cloudflare.WorkersCronTrigger('gatekeeper', {
    accountId,
    scriptName: gatekeeperWorker.name,
    schedules: [{ cron: '*/15 * * * *' }]
  });
}

/** Gatekeeper's build settings, read from STACK_OUTPUT_JSON. */
export const gatekeeper = {
  domain: gatekeeperDomain,
  hyperdriveId: gatekeeperHyperdrive.id,
  versionId: gatekeeperVersionId
};
/** Every gatekeeper secret binding, uploaded with each version through `--secrets-file`. */
export const gatekeeperSecrets = pulumi.secret({
  MOQ_SIGNING_KEYS: moqSigningKeys,
  MOQ_RELAY_TOKEN: moqRelayToken.hex,
  MOQ_CLUSTER_TOKEN: moqClusterToken.hex,
  IROH_RELAY_TOKEN: irohToken.hex
});
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
