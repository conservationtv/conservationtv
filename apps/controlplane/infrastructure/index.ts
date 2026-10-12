import * as pulumi from '@pulumi/pulumi';
import * as random from '@pulumi/random';
import { AcmeIssuer, CloudflareDnsRegistrar, DigitalOceanProvider, Fleet, Node } from '@moq-ha/vps-fleet';
import { MoqRelayWorkload } from '@moq-ha/vps-fleet/moq';
import { IrohRelayWorkload } from '@moq-ha/vps-fleet/iroh';

const config = new pulumi.Config();
const stack = pulumi.getStack();
const name = `controlplane-${stack}`;
const domain = config.require('domain');
const zoneId = config.require('zoneId');
const gatekeeperUrl = config.require('gatekeeperUrl').replace(/\/$/, '');
const moqHostname = `moq-${stack}.${domain}`;
const irohHostname = `iroh-${stack}.${domain}`;

const fleet = new Fleet('fleet', {
  namePrefix: name,
  environment: stack,
  ssh: { port: 2222, allowedCidrs: [config.require('sshCidr')] },
  hostnameStrategy: (_node, hostname) => hostname
});
// Provider credentials come from Pulumi config; the native providers validate them.
const machines = new DigitalOceanProvider('machines', { fleet, preflight: { skipPreflight: true } });
const dns = new CloudflareDnsRegistrar('dns', { zoneId, preflight: { skipPreflight: true } });
const acme = new AcmeIssuer('acme', {
  serverUrl: 'https://acme-v02.api.letsencrypt.org/directory',
  email: config.require('acmeEmail'),
  dnsChallenge: { provider: 'cloudflare', apiToken: new pulumi.Config('cloudflare').requireSecret('apiToken') }
});
const moqNode = new Node('moq', { fleet, provider: machines, providerRegion: 'lon1' });
const irohNode = new Node('iroh', { fleet, provider: machines, providerRegion: 'lon1' });

const moqRelayToken = new random.RandomBytes('moq-relay-token', { length: 32 });
const moqClusterToken = new random.RandomBytes('moq-cluster-token', {
  length: 32,
  keepers: { generation: config.get('clusterTokenGeneration') ?? '1' }
});

const irohToken = new random.RandomBytes('iroh-token', { length: 32 });
const moq = new MoqRelayWorkload('moq-relay', {
  fleet,
  relays: [{ node: moqNode }],
  domain: moqHostname,
  dns,
  acme,
  authOrigin: gatekeeperUrl,
  authToken: pulumi.secret(moqRelayToken.hex),
  clusterToken: pulumi.secret(moqClusterToken.hex)
});
const iroh = new IrohRelayWorkload('iroh-relay', {
  fleet,
  nodes: [irohNode],
  domain: irohHostname,
  dns,
  acme,
  admissionUrl: `${gatekeeperUrl}/relays/iroh/admission`,
  admissionToken: pulumi.secret(irohToken.hex)
});

export const gatekeeperSecrets = pulumi.secret({
  MOQ_RELAY_TOKEN: moqRelayToken.hex,
  MOQ_CLUSTER_TOKEN: moqClusterToken.hex,
  IROH_RELAY_TOKEN: irohToken.hex
});
export const moqDirectory = moq.directory;
export const irohDirectory = iroh.directory;
export const sshConfig = pulumi.interpolate`${moq.sshConfig}\n${iroh.sshConfig}`;
export const sshPrivateKey = fleet.bootstrapSshKey.privateKeyPem;
