# `@moq-ha/vps-fleet`

Pulumi TypeScript components that provision VPS machines and deploy Docker Compose apps to them over SSH, plus MoQ and
Iroh relay clusters built on the same pieces.

```ts
import { Fleet, DigitalOceanMachine, ComposeWorkload } from '@moq-ha/vps-fleet';
import { MoqRelayCluster } from '@moq-ha/vps-fleet/moq';
import { IrohRelayCluster } from '@moq-ha/vps-fleet/iroh';
```

## How it composes

Every component is `new X(name, args, opts)`. Relationships flow through args, ownership through `opts.parent`, and
credentials through `opts.provider(s)`. Components never call methods on each other; they exchange plain data (a
`Machine`, a `PublicTlsMaterial`, a `ComposeApp`).

```
Fleet ──▶ DigitalOceanMachine / OpenStackMachine      one VPS, base firewall, cloud-init done
             │ (Machine)
             ▼
          ComposeDeployment                            one Compose app on one machine: files, systemd unit,
             ▲                                         pull/up, health gate, endpoint firewall rules, DNS
          ComposeWorkload                              one app on many machines, parallel or serial rollout
             ▲
          MoqRelayCluster · IrohRelayCluster           relay apps + directories
          NetdataAgent · CloudflareMeshConnector       per-machine node services
```

`AcmeAccount` and `AcmeCertificate` produce TLS material that relay clusters take as `tls`. Several deployments may share
a machine: each claims its listeners, paths and container names on the machine at plan time, and a collision fails the
program before anything is created.

## Example

```ts
import * as digitalocean from '@pulumi/digitalocean';
import * as pulumi from '@pulumi/pulumi';
import * as random from '@pulumi/random';
import { AcmeAccount, AcmeCertificate, DigitalOceanMachine, Fleet, renderSshConfig } from '@moq-ha/vps-fleet';
import { MoqRelayCluster } from '@moq-ha/vps-fleet/moq';
import { IrohRelayCluster } from '@moq-ha/vps-fleet/iroh';

const config = new pulumi.Config();
const zoneId = config.require('zoneId');

const fleet = new Fleet('fleet', {
  namePrefix: 'relays',
  environment: pulumi.getStack(),
  ssh: { port: 2222, allowedCidrs: [config.require('sshCidr')] }
});
// Without a registered key DigitalOcean emails a root password; access itself uses the key cloud-init installs.
const sshKey = new digitalocean.SshKey('bootstrap', { name: 'relays-bootstrap', publicKey: fleet.publicKeyOpenSsh });
const london = new DigitalOceanMachine('london', { fleet, region: 'lon1', sshKeys: [sshKey.id] });
const newYork = new DigitalOceanMachine('new-york', { fleet, region: 'nyc3', sshKeys: [sshKey.id] });

const acme = new AcmeAccount('acme', {
  serverUrl: 'https://acme-v02.api.letsencrypt.org/directory',
  // apiToken defaults to CLOUDFLARE_API_TOKEN, which the Cloudflare provider also reads.
  dnsChallenge: { provider: 'cloudflare' }
});

const moqCertificate = new AcmeCertificate('moq-tls', {
  account: acme,
  names: ['lon.moq.example.com', 'nyc.moq.example.com']
});
const irohCertificate = new AcmeCertificate('iroh-tls', { account: acme, names: ['lon.iroh.example.com'] });

const relayToken = new random.RandomBytes('moq-relay-token', { length: 32 });
const clusterToken = new random.RandomBytes('moq-cluster-token', { length: 32 });
const moq = new MoqRelayCluster('moq', {
  relays: [
    { machine: london, hostname: 'lon.moq.example.com', peers: [newYork] },
    { machine: newYork, hostname: 'nyc.moq.example.com', peers: [london] }
  ],
  tls: moqCertificate,
  dns: { provider: 'cloudflare', zoneId },
  auth: { origin: 'https://gatekeeper.example.com', token: relayToken.hex, clusterToken: clusterToken.hex },
  rollout: 'serial'
});

// Iroh shares the London machine with MoQ, so it moves HTTPS off 443.
const irohToken = new random.RandomBytes('iroh-token', { length: 32 });
const iroh = new IrohRelayCluster('iroh', {
  relays: [{ machine: london, hostname: 'lon.iroh.example.com' }],
  tls: irohCertificate,
  dns: { provider: 'cloudflare', zoneId },
  admission: { url: 'https://gatekeeper.example.com/relays/iroh/admission', token: irohToken.hex },
  ports: { https: 8443 }
});

export const moqDirectory = moq.directory;
export const irohDirectory = iroh.directory;
export const sshConfig = renderSshConfig([london, newYork], { aliasPrefix: 'relays' });
export const sshPrivateKey = fleet.privateKeyPem;
```

`apps/controlplane/infrastructure` is a complete stack built this way.

## Operational notes

- Machines run Ubuntu 24.04 with Docker, and sshd on the fleet port with key-only auth. Remote work waits for
  cloud-init.
- Each app lives in `/opt/<name>` with a `docker-compose.yml` and a `<name>.service` systemd unit. All files are
  written by one script before any redeploy, so a deploy never sees a half-written app.
- A file's `onChange` decides its rollout: `redeploy` (pull and recreate), `restart` (restart in place, used for
  certificates so renewals roll independently of redeploys) or `none`. Health checks gate both.
- Public host endpoints open the cloud firewall for exactly their port and transport; private and loopback endpoints
  stay closed.
- Untagged images produce a warning; pin a tag and preferably a digest.
- The bootstrap SSH key, ACME keys, relay tokens and Mesh tokens are Pulumi secrets. Use an encrypted state backend.

```sh
pulumi stack output sshPrivateKey --show-secrets > fleet-ssh.key && chmod 600 fleet-ssh.key
pulumi stack output sshConfig > fleet-ssh.config
ssh -F fleet-ssh.config relays-london
```

See [`COMPONENTS.md`](./COMPONENTS.md) for each component's arguments and outputs, and
[`docs/topology/`](./docs/topology/README.md) for how the layers fit together.

## Development

```sh
pnpm run build
pnpm run check
pnpm test
```

`test/automation-e2e.test.ts` is opt-in (`FLEET_E2E=1`) and previews or deploys the controlplane stack against a local
file backend; see the comment at its top.
