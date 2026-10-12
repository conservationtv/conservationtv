import * as digitalocean from '@pulumi/digitalocean';
import * as pulumi from '@pulumi/pulumi';
import * as random from '@pulumi/random';
import { AcmeAccount, AcmeCertificate, DigitalOceanMachine, Fleet, renderSshConfig } from '@moq-ha/vps-fleet';
import { MoqRelayCluster } from '@moq-ha/vps-fleet/moq';
import { IrohRelayCluster } from '@moq-ha/vps-fleet/iroh';

const config = new pulumi.Config();
const stack = pulumi.getStack();
const name = `controlplane-${stack}`;
const domain = config.require('domain');
const zoneId = config.require('zoneId');
const gatekeeperUrl = config.require('gatekeeperUrl');
const moqHostname = `moq-${stack}.${domain}`;
const irohHostname = `iroh-${stack}.${domain}`;

const fleet = new Fleet('fleet', {
  namePrefix: name,
  environment: stack,
  ssh: { port: 2222, allowedCidrs: [config.require('sshCidr')] }
});
// Without a registered key DigitalOcean emails a root password; access itself uses the key cloud-init installs.
const sshKey = new digitalocean.SshKey('bootstrap-ssh-key', {
  name: `${name}-bootstrap`,
  publicKey: fleet.publicKeyOpenSsh
});
const moqMachine = new DigitalOceanMachine('moq-london', {
  fleet,
  region: 'lon1',
  hostname: moqHostname,
  sshKeys: [sshKey.id]
});
const irohMachine = new DigitalOceanMachine('iroh-london', {
  fleet,
  region: 'lon1',
  hostname: irohHostname,
  sshKeys: [sshKey.id]
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

export const gatekeeperSecrets = pulumi.secret({
  MOQ_RELAY_TOKEN: moqRelayToken.hex,
  MOQ_CLUSTER_TOKEN: moqClusterToken.hex,
  IROH_RELAY_TOKEN: irohToken.hex
});
export const moqDirectory = moq.directory;
export const irohDirectory = iroh.directory;
export const sshConfig = renderSshConfig([moqMachine, irohMachine], { aliasPrefix: name });
export const sshPrivateKey = fleet.privateKeyPem;
