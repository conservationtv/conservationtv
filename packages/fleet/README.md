# `@moq-ha/vps-fleet`

Pulumi TypeScript components for creating multi-provider VPS fleets and deploying
Docker Compose workloads over SSH. MoQ and Iroh relay fleets are supplied as workload
components on top of the generic core.

## API levels

- High level: `new Fleet()`, `new Node()`, `new ComposeWorkload()`,
  `new MoqRelayWorkload()`, and `new IrohRelayWorkload()`. A node owns one machine and
  may be included in multiple workloads.
- Low level: cloud-init rendering, `MachineProvider`, `ComposeHost`, certificate
  issuers, DNS registrars, and addon factories. Use these when the high-level workload
  topology is not a fit. Custom machine providers return a `Machine` whose
  `addIngress()` method installs additional firewall policy on the existing machine.

Imports are split by concern:

```ts
import { Fleet, DigitalOceanProvider, NetdataAddon } from '@moq-ha/vps-fleet/core';
import { MoqRelayWorkload } from '@moq-ha/vps-fleet/moq';
import { IrohRelayWorkload } from '@moq-ha/vps-fleet/iroh';
```

See `examples/minimal` for a generic one-node Compose workload and
`examples/moq-iroh-fleet` for a multi-provider relay deployment.

See [`COMPONENTS.md`](./COMPONENTS.md) for the complete component-by-component API
reference and composition guide.

See [`docs/topology/`](./docs/topology/README.md) for a level-by-level topology walkthrough
with diagrams, from primitives up to a whole fleet, and an interactive explorer
(`docs/topology/explorer.html`).

MoQ defaults to `moqdev/moq-relay:0.17.2`. `MoqRelayWorkload` takes each relay's peers, the gatekeeper origin and two
shared Pulumi-generated keys, and derives peer URLs from fleet hostnames. Relays present the auth key on admission
callbacks to gatekeeper and the cluster token to each other, both over ordinary server-authenticated TLS. See the authentication
and workload sections of `COMPONENTS.md` for deployment ordering and certificate rotation.

Iroh defaults to the digest-pinned `n0computer/iroh-relay:v1.3.0` image exported as
`IROH_RELAY_IMAGE`. Supply `admissionUrl` (gatekeeper's HTTPS
`/relays/iroh/admission` URL) and `admissionToken` (the same secret as gatekeeper's
`IROH_RELAY_TOKEN`). The relay asks gatekeeper about each connecting endpoint and
admits only a `200 true` response. This replaces the old `accessToken` input.
The callback token belongs to the relay, not to application clients.

## Operational behavior

- Ubuntu 24.04 hosts are bootstrapped with Docker and a non-standard, key-only SSH port.
- Remote files are installed in one batched SSH command before named deploy steps run.
- Workloads can roll out in parallel or serially. Serial rollout provisions machines
  concurrently but health-gates each node's workload before updating the next node.
- Workloads sharing a node deploy sequentially so remote file and systemd changes do
  not race on the same machine.
- Certificate files have separate triggers from image/config deploys, allowing renewal
  restarts to roll independently.
- Stack outputs can include a fleet summary, workload directories, ready-to-use
  `ssh_config`, and the secret bootstrap key.
- Public images should use digest-pinned references. Untagged references produce a
  Pulumi warning.

## Service endpoints

Compose apps and addons own their listeners through endpoint declarations:

```ts
endpoints: {
  "api.https": {
    service: "api",
    port: 443,
    targetPort: 443,
    transport: "tcp",
    visibility: "public",
    scheme: "https",
    paths: { health: "/health" },
  },
}
```

`port` is the host-facing listener and optional `targetPort` describes the container
listener when they differ. `ComposeWorkload` derives public host firewall rules from
these declarations. Private
and loopback endpoints remain closed at the cloud firewall. `ComposeHost` rejects
duplicate endpoint IDs, references to unknown Compose services, and host listener
collisions between different services. Resolved endpoint catalogs are included in node
summaries and MoQ/Iroh directories, so consumers discover ports without knowing which
addon supplied them.

## Shared nodes

Pass the same `Node` object to multiple workloads to deploy them onto one machine. Set
`NodeArgs.hostname` to a stable machine FQDN when workloads use different domains; each
workload hostname remains a DNS alias and is still used in its endpoint URLs.

```ts
const node = new Node('shared-na-east', {
  fleet,
  provider,
  providerRegion: 'nyc3',
  hostname: 'na-east.nodes.example.test'
});

new ComposeWorkload('api', { fleet, nodes: [node], domain: 'api.example.test', app: apiApp });
new ComposeWorkload('admin', { fleet, nodes: [node], domain: 'admin.example.test', app: adminApp });
```

The node validates host listener ports, remote file and systemd paths, Compose
directories, and explicit container names across workloads. Host-network services must
declare every listener as an endpoint, including private and loopback listeners, so
collisions can be detected before deployment. Public endpoint declarations add
workload-specific firewall rules to the shared machine.

Built-in Netdata and Cloudflare Mesh addons are node-scoped. Reusing the same addon
instance in multiple workloads deploys it only once on each shared node. Workload-scoped
custom addons continue to deploy with every workload.

MoQ and Iroh both use TCP 443 by default. To colocate them, assign Iroh another HTTPS
port; directory and health URLs include the configured port automatically:

```ts
new IrohRelayWorkload('iroh', {
  // ...
  nodes: [node],
  ports: { https: 8443 },
  admissionUrl: 'https://gatekeeper.example.com/relays/iroh/admission',
  admissionToken: irohToken
});
```

## SSH

Export the generated files from a deployed example stack:

```sh
pulumi stack output sshPrivateKey --show-secrets > fleet-ssh.key
chmod 600 fleet-ssh.key
pulumi stack output sshConfig > fleet-ssh.config
ssh -F fleet-ssh.config myapp-moq-na-east
```

Store Pulumi state in an encrypted backend. The bootstrap SSH private key, ACME account
key, relay auth credentials, and Mesh node tokens are state secrets.

## Cloudflare Mesh

The Mesh addon uses the official `cloudflare/mesh` container, persistent registration
state, `MESH_NODE_TOKEN`, source NAT, and a default-route safety check. A pinned official
image is supplied by default and can be overridden.

Hostname route intent can be declared. The Cloudflare Pulumi provider version currently
used by this workspace does not expose the 2026 hostname-route resource, so the addon
emits an actionable warning and the route must currently be created through the
Cloudflare dashboard or API. It is never silently treated as provisioned.

## Verification

```sh
npm run build
npm run check
npm test
```

Pure unit tests cover renderers, naming, validation, firewall translation, compose
merging and stable cluster IDs. Opt-in Automation API tests run the real
example stacks with a local file backend; see `examples/README.md`.
