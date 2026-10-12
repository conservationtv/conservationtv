import * as digitalocean from '@pulumi/digitalocean';
import * as pulumi from '@pulumi/pulumi';
import * as random from '@pulumi/random';
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

/** Build settings for gatekeeper's `cf deploy`: its custom domain and the Hyperdrive config it binds. */
export const gatekeeper = { domain: gatekeeperDomain, hyperdriveId: config.get('gatekeeperHyperdriveId') };
export const gatekeeperSecrets = pulumi.secret({
  MOQ_RELAY_TOKEN: moqRelayToken.hex,
  MOQ_CLUSTER_TOKEN: moqClusterToken.hex,
  IROH_RELAY_TOKEN: irohToken.hex
});
export const moqDirectory = moq.directory;
export const irohDirectory = iroh.directory;
export const sshConfig = renderSshConfig([moqMachine, irohMachine], { aliasPrefix: `controlplane-${stack}` });
export const sshPrivateKey = fleet.privateKeyPem;
