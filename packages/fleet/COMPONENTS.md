# Pulumi component reference

This document covers every Pulumi `ComponentResource` exported by
`@moq-ha/vps-fleet`. It only describes the reusable library in `packages/fleet`; the
application stack under `/infra` is deliberately out of scope.

The library has three entry points:

```ts
import { Fleet, Node, ComposeWorkload } from '@moq-ha/vps-fleet/core';
import { MoqRelayWorkload } from '@moq-ha/vps-fleet/moq';
import { IrohRelayWorkload } from '@moq-ha/vps-fleet/iroh';
```

## How the components fit together

A normal deployment starts with a `Fleet`, one or more machine providers, and a set of
logical `Node` objects. A workload attaches an application to those nodes. Attaching
the first workload to a node provisions its machine; later workloads can reuse the
same machine.

```text
Fleet
├── BootstrapSshKey
├── DigitalOceanProvider or OpenStackProvider
│   └── creates a MachineComponent for each attached Node
├── Node × N
│   ├── machine and cloud firewall policy, created on first attachment
│   └── node-scoped ComposeHost × addon, created at most once per node
└── ComposeWorkload, MoqRelayWorkload, or IrohRelayWorkload
    └── NodeDeployment × N
        ├── workload-scoped addon contributions
        ├── ComposeHost
        └── DNS A/AAAA records through a DnsRegistrar
```

Certificate issuers and DNS registrars are independent components passed into the
workloads that need them:

```text
AcmeIssuer ─────────────────> MoqRelayWorkload
                                 │
                                 └──> ComposeWorkload orchestration

AcmeIssuer ─────────────────> IrohRelayWorkload
                                     │
                                     └──> ComposeWorkload orchestration

CloudflareDnsRegistrar ─────> any workload's NodeDeployment resources
Addon components ───────────> any ComposeWorkload
```

The important lifecycle boundaries are:

1. `Fleet` owns naming, SSH policy, and the generated bootstrap key.
2. A `MachineProvider` translates the library's provider-neutral machine and firewall
   model into cloud resources.
3. A `Node` owns one machine and arbitrates all claims on that machine.
4. A `ComposeWorkload` creates one `NodeDeployment` per node.
5. A `NodeDeployment` combines the application and addons, derives firewall rules
   from public endpoints, attaches to the node, deploys through `ComposeHost`, and
   creates DNS records.
6. `MoqRelayWorkload` and `IrohRelayWorkload` prepare their protocol-specific
   certificates, topology, and Compose application, then delegate the per-node work to
   `ComposeWorkload`.

## Which components should I instantiate?

| Component                                           | Typical use                                                                 |
| --------------------------------------------------- | --------------------------------------------------------------------------- |
| `Fleet`                                             | Always create one for a related group of nodes and workloads.               |
| `DigitalOceanProvider`, `OpenStackProvider`         | Create the cloud backends used by the nodes.                                |
| `Node`                                              | Create once per logical machine. Reuse it to colocate workloads.            |
| `ComposeWorkload`                                   | Deploy an arbitrary Docker Compose application.                             |
| `MoqRelayWorkload`, `IrohRelayWorkload`             | Deploy the built-in relay applications.                                     |
| `CloudflareDnsRegistrar`                            | Add unproxied A/AAAA records during node deployment.                        |
| `AcmeIssuer`                                        | Supply TLS material to workloads.                                           |
| `NetdataAddon`, `CloudflareMeshAddon`               | Add node services to a workload.                                            |
| `BootstrapSshKey`                                   | Normally created automatically by `Fleet`.                                  |
| `NodeDeployment`, `ComposeHost`, `MachineComponent` | Normally created by higher-level components; useful for library extensions. |
| `MachineProvider`, `Addon`                          | Abstract bases for custom providers and addons.                             |

## Core orchestration components

### `Fleet`

Pulumi type: `fleet:core:Fleet`

`Fleet` is the root context shared by providers, nodes, and workloads. It normalizes
resource naming, validates the SSH access policy, defines how workload hostnames are
formed, and creates a `BootstrapSshKey` child.

Constructor arguments:

| Argument           | Required | Meaning                                                                             |
| ------------------ | -------- | ----------------------------------------------------------------------------------- |
| `namePrefix`       | yes      | Prefix used in cloud resource names and tags. It is normalized with `resourceName`. |
| `environment`      | yes      | Environment/stack label used in names and tags. It is also normalized.              |
| `ssh.port`         | yes      | Non-standard SSH port from 1–65535. Port 22 is rejected.                            |
| `ssh.allowedCidrs` | yes      | IPv4/IPv6 CIDRs allowed to reach SSH. An empty list resolves to `0.0.0.0/0`.        |
| `hostnameStrategy` | no       | `(node, baseDomain) => hostname`; defaults to `<node.id>.nodes.<domain>`.           |

Public members:

| Member                             | Meaning                                                           |
| ---------------------------------- | ----------------------------------------------------------------- |
| `bootstrapSshKey`                  | The generated `BootstrapSshKey`.                                  |
| `namePrefix`, `environment`, `ssh` | Validated, normalized fleet settings.                             |
| `hostnameFor(node, domain)`        | Resolves and validates the DNS hostname for a workload/node pair. |
| `tagsFor(machineName)`             | Returns the common cloud tag set for a machine.                   |

The same `Fleet` instance must be passed to a provider, its nodes, and every workload
using those nodes. A workload rejects nodes from another fleet.

### `BootstrapSshKey`

Pulumi type: `fleet:core:BootstrapSshKey`

This component creates a 4096-bit RSA key through `@pulumi/tls`. Its
`publicKeyOpenSsh` is installed in cloud provider metadata and cloud-init. Its
`privateKeyPem` is marked as a Pulumi secret and is used by `ComposeHost` for remote
deployment.

It has no arguments beyond the Pulumi component name and options. Its public outputs
are:

| Output             | Meaning                    |
| ------------------ | -------------------------- |
| `publicKeyOpenSsh` | OpenSSH-format public key. |
| `privateKeyPem`    | Secret PEM private key.    |

Normal stack code uses `fleet.bootstrapSshKey`; create this component directly only
when building lower-level orchestration outside `Fleet`.

### `Node`

Pulumi type: `fleet:core:Node`

`Node` is the stable logical identity and lifecycle owner for one VPS. Construction is
lazy: creating a `Node` alone does not create a machine. The first workload attachment
renders cloud-init and asks the selected `MachineProvider` to provision it.

Constructor arguments:

| Argument                | Required | Meaning                                                                                                                                       |
| ----------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `fleet`                 | yes      | Owning `Fleet`.                                                                                                                               |
| `provider`              | yes      | `MachineProvider` that creates the VPS.                                                                                                       |
| `providerRegion`        | yes      | Provider region; for OpenStack it must match the provider component's region.                                                                 |
| `id`                    | no       | Logical lowercase DNS label. Defaults to the component name.                                                                                  |
| `displayName`           | no       | Human-readable region/name used in directories. Defaults to `id`.                                                                             |
| `size`                  | no       | Provider-specific machine size/flavor override.                                                                                               |
| `latitude`, `longitude` | no       | Location metadata retained on the node.                                                                                                       |
| `priority`              | no       | Rollout/directory ordering priority. Defaults to `0`; ties sort by `id`.                                                                      |
| `metadata`              | no       | Additional string metadata available to hostname strategies.                                                                                  |
| `enableIpv6`            | no       | Requests an IPv6 address from the provider. Defaults to `false`.                                                                              |
| `hostname`              | no       | Stable machine FQDN. Otherwise the first attached workload hostname becomes canonical.                                                        |
| `cloudInit`             | no       | Overrides for packages, files, commands, Docker installation, or sshd config name. Identity and SSH key fields remain controlled by the node. |

Important public members are `id`, `machineName`, `provider`, `providerRegion`,
`displayName`, `priority`, `metadata`, `attachedWorkloads`, `hostname`, and `machine`.
The last two throw until a workload has attached.

A node also protects shared-host safety. Across workloads it rejects collisions in:

- host-bound protocol/port listeners;
- remote file and systemd-unit paths;
- explicit Compose `container_name` values.

Deployments sharing a node are chained in attachment order so remote writes and
systemd changes do not run concurrently. Give a shared node an explicit `hostname`
when its workloads use different domains; workload hostnames still become DNS names
and endpoint URLs.

### `ComposeWorkload`

Pulumi type: `fleet:core:ComposeWorkload`

`ComposeWorkload` deploys one logical Compose application to a set of nodes. It sorts
the nodes by `priority` and `id`, resolves a hostname for each, and creates a
`NodeDeployment` per node.

Constructor arguments:

| Argument  | Required | Meaning                                                       |
| --------- | -------- | ------------------------------------------------------------- |
| `fleet`   | yes      | Fleet shared by every node.                                   |
| `nodes`   | yes      | Non-empty, unique set of `Node` objects.                      |
| `domain`  | yes      | Base domain passed to `fleet.hostnameFor`.                    |
| `app`     | yes      | `(context) => ComposeApp` factory evaluated once per node.    |
| `dns`     | no       | `DnsRegistrar` used for A and optional AAAA records.          |
| `ingress` | no       | Extra firewall intents in addition to endpoint-derived rules. |
| `addons`  | no       | Addon components attached on each node.                       |
| `rollout` | no       | `parallel` (default behavior) or `serial`.                    |

Outputs and public members:

| Member         | Meaning                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------- |
| `workloadName` | The component name, used in aliases and summaries.                                                 |
| `nodes`        | Read-only map of logical node ID to `NodeDeployment`.                                              |
| `summary`      | Output array containing provider, address, hostname, health URL, endpoint, and optional Mesh data. |
| `sshConfig`    | Ready-to-export OpenSSH config for this workload.                                                  |

`serial` rollout does not serialize machine creation. It adds dependencies between
the completion resources of adjacent node deployments, so application updates and
health gates run in node order after infrastructure can provision concurrently.

The application factory receives:

```ts
interface NodeContext {
  fleet: Fleet;
  node: Node;
  workloadName: string;
  hostname: string;
}
```

It returns a `ComposeApp` with a sanitized name, an absolute remote directory,
services, files, deploy steps, and optional volumes, systemd units, endpoints, and
health URL. Public host-bound endpoints automatically become cloud firewall ingress;
private and loopback endpoints stay closed externally.

### `NodeDeployment`

Pulumi type: `fleet:core:NodeDeployment`

This is the per-node orchestration unit created by `ComposeWorkload`. Most callers do
not instantiate it directly.

For one node it:

1. attaches each addon and separates node-scoped from workload-scoped contributions;
2. evaluates the `ComposeApp` factory;
3. merges and validates endpoint declarations;
4. derives public ingress and combines explicit ingress;
5. claims listeners, paths, and container names on the `Node`;
6. causes the node's machine to be created if this is its first workload;
7. deploys new node-scoped addons in their own `ComposeHost` components;
8. creates the workload `ComposeHost`;
9. creates A/AAAA records through the optional registrar; and
10. builds its workload summary.

Its useful public members are `node`, `hostname`, `machine`, `host`, `app`,
`endpoints`, `contributions`, `nodeAddonHosts`, `summary`, and `sshAlias`.

Instantiate it directly only when you need the per-node behavior without the
multi-node validation, ordering, `summary`, and `sshConfig` aggregation supplied by
`ComposeWorkload`.

### `ComposeHost`

Pulumi type: `fleet:core:ComposeHost`

`ComposeHost` is the low-level remote deployment component. It waits for cloud-init,
writes the generated `docker-compose.yml` and all declared files in one remote
manifest command, then creates one `@pulumi/command` remote resource per deploy step.

Constructor arguments:

| Argument           | Required | Meaning                                                                     |
| ------------------ | -------- | --------------------------------------------------------------------------- |
| `machine`          | yes      | Provider-neutral `Machine` with address, SSH users, and lifecycle resource. |
| `ssh`              | yes      | Validated SSH port and source policy.                                       |
| `sshPrivateKeyPem` | yes      | Private key used for remote commands. Keep it secret.                       |
| `app`              | yes      | Base `ComposeApp`.                                                          |
| `addons`           | no       | Workload-scoped contributions merged into the app's Compose project.        |
| `deployAfter`      | no       | Resources that every deploy step must wait for.                             |

Public members:

| Member                | Meaning                                                                   |
| --------------------- | ------------------------------------------------------------------------- |
| `deploySteps`         | Read-only map of sanitized step name to remote command.                   |
| `completionResources` | All deploy-step commands; used to sequence rollouts and shared workloads. |
| `healthUrl`           | The app-declared health URL, if any.                                      |
| `endpoints`           | Validated, resolved endpoint catalog.                                     |

The component rejects invalid app names/directories, duplicate Compose service or
volume names, duplicate file paths, invalid/duplicate deploy steps, forward references
between steps, unknown endpoint services, and listener collisions. The token
`{{composeFile}}` in file content or step scripts is replaced with the generated
Compose file path. Image references without an explicit tag produce a Pulumi warning;
digest pinning is preferred.

## Machine provider components

### `MachineProvider`

`MachineProvider` is the abstract component base for provider adapters. It has no
single Pulumi type because each concrete subclass supplies its own type. A provider
must expose `providerName` and implement:

```ts
createMachine(
  name: string,
  args: MachineArgs,
  opts?: pulumi.ComponentResourceOptions,
): Machine;
```

The returned `Machine` supplies IPv4 and optional IPv6 outputs, SSH usernames, its
primary cloud resource, and `addIngress()`. The latter is essential for shared nodes:
each workload can add firewall policy to the already-created machine.

Custom providers should preserve the passed parent options, translate both ingress
and egress intents, support additional ingress after creation, and return the real
cloud resource in `resource` so remote deployment waits for it.

### `MachineComponent`

Pulumi type: `fleet:core:Machine`

`MachineComponent` wraps a provider-specific `Machine` implementation in a stable
component boundary. `DigitalOceanProvider` and `OpenStackProvider` create it for each
node. It exposes `address`, optional `addressV6`, `sshUsers`, `resource`, and delegates
`addIngress()` to the provider implementation.

Its constructor accepts a factory function whose parent argument should be used for
all provider-specific child resources. Application stacks normally never construct
this component directly; it is the recommended wrapper for custom `MachineProvider`
implementations.

### `DigitalOceanProvider`

Pulumi type: `fleet:core:DigitalOceanProvider`

This provider component creates one fleet bootstrap SSH key in DigitalOcean and then
creates droplets, tags, and firewalls as nodes attach.

| Argument      | Required | Default/meaning                                            |
| ------------- | -------- | ---------------------------------------------------------- |
| `fleet`       | yes      | Owning `Fleet`; cross-fleet machine requests are rejected. |
| `image`       | no       | `ubuntu-24-04-x64`.                                        |
| `defaultSize` | no       | `s-1vcpu-2gb`.                                             |
| `preflight`   | no       | Overrides/skips environment credential checks.             |

A node's `size` overrides `defaultSize`. `providerRegion` selects the droplet region,
so one component can create nodes in multiple DigitalOcean regions. Monitoring is
enabled. IPv6 follows `Node.enableIpv6`. SSH users are `root` for both cloud-init and
deployment.

Initial SSH ingress lives in the machine firewall. Later workload ingress creates
additional tag-targeted firewall resources. Default egress permits all TCP, UDP, and
ICMP to IPv4 and IPv6 destinations.

Pass an explicit native `digitalocean.Provider` through Pulumi component options when
you do not want ambient provider configuration:

```ts
const digitalOcean = new DigitalOceanProvider('do', { fleet }, { providers: [digitalOceanProvider] });
```

The component registers `sshKeyIds` as a Pulumi output for resource-tree/state
inspection; it is not exposed as a public TypeScript member.

### `OpenStackProvider`

Pulumi type: `fleet:core:OpenStackProvider`

This component creates an OpenStack key pair and, for each attached node, a security
group, individual security-group rules, and a compute instance.

| Argument              | Required | Default/meaning                                     |
| --------------------- | -------- | --------------------------------------------------- |
| `fleet`               | yes      | Owning `Fleet`; cross-fleet requests are rejected.  |
| `region`              | yes      | Fixed OpenStack region for this provider component. |
| `imageName`           | no       | `Ubuntu 24.04`.                                     |
| `defaultFlavor`       | no       | `d2-4`.                                             |
| `externalNetworkName` | no       | `Ext-Net`.                                          |
| `preflight`           | no       | Overrides/skips environment credential checks.      |

Create one `OpenStackProvider` per region. A node whose `providerRegion` differs from
the component's configured region is rejected. `Node.size` overrides the default
flavor. SSH users are `ubuntu` for cloud-init and deployment, so remote scripts are
run through `sudo`. IPv4 comes from `accessIpV4`; IPv6 is returned only when requested.

Each firewall intent expands to one OpenStack rule per CIDR, with IPv4/IPv6 ethertype
selected from the CIDR. Additional workload ingress is added to the node's existing
security group.

The component registers `keyPairName` as a Pulumi output for resource-tree/state
inspection; it is not exposed as a public TypeScript member.

## DNS and certificate components

### `CloudflareDnsRegistrar`

Pulumi type: `fleet:core:CloudflareDnsRegistrar`

This is the built-in implementation of the provider-neutral `DnsRegistrar` interface.
It creates an unproxied A record and, when an IPv6 address exists, an unproxied AAAA
record.

| Argument    | Required | Default/meaning                               |
| ----------- | -------- | --------------------------------------------- |
| `zoneId`    | yes      | Cloudflare zone receiving the records.        |
| `ttl`       | no       | Default `60` seconds.                         |
| `preflight` | no       | Overrides/skips Cloudflare credential checks. |

`createAddressRecords()` accepts a per-call TTL override. `NodeDeployment` calls it
after the machine address is available, using the workload hostname. Pass the
registrar to any `ComposeWorkload`, `MoqRelayWorkload`, or `IrohRelayWorkload` through
its `dns` argument.

Other DNS systems can implement `DnsRegistrar`; they do not need to extend this
component.

### `AcmeIssuer`

Pulumi type: `fleet:core:AcmeIssuer`

`AcmeIssuer` creates a dedicated ACME provider, P-256 account key, and account
registration. Its `issueCertificate()` method creates P-256 certificates with a
Cloudflare DNS-01 challenge.

| Argument                | Required | Meaning                                                              |
| ----------------------- | -------- | -------------------------------------------------------------------- |
| `serverUrl`             | yes      | ACME directory URL, such as Let's Encrypt production or staging.     |
| `email`                 | no       | ACME registration email.                                             |
| `dnsChallenge.provider` | yes      | Currently only `cloudflare`.                                         |
| `dnsChallenge.apiToken` | yes      | Cloudflare DNS token; stored as a Pulumi secret in challenge config. |

`issueCertificate(name, { commonName, subjectAlternativeNames?, minDaysRemaining? })`
returns `fullchainPem`, `privateKeyPem`, and `notAfter`. The renewal threshold defaults
to 30 days. The MoQ and Iroh workload components call it once per workload for the
base domain plus `nodes.<domain>` and `*.nodes.<domain>` names.

### MoQ callback authentication

Relays authenticate their admission callbacks with a shared auth key: generate 32 bytes with `random.RandomBytes` and
pass its secret hex to `MoqRelayWorkload.authToken`. moq-relay 0.17.2 has no header setting for its auth callout, so
the key is userinfo in the callback URL (`https://moq-relay:<key>@<authOrigin>/relays/moq/admission`), which the relay
sends as HTTP Basic credentials. The URL is the `MOQ_AUTH_URL` container environment variable in the `0600` compose
file, never the world-readable `relay.toml`. It becomes gatekeeper's `MOQ_RELAY_TOKEN` secret binding. Key changes
trigger a relay deployment.

Peer sessions use a second shared key, the cluster token: generate 32 bytes with `random.RandomBytes` and pass its
secret hex to `MoqRelayWorkload.clusterToken`. It becomes gatekeeper's `MOQ_CLUSTER_TOKEN` secret binding and each
relay's `/opt/moq/secrets/cluster-token` file (`0600`). The token is opaque lowercase hex, not a JWT. Use a `keepers`
value to rotate it explicitly. Relay deployment triggers include the secret so a change recreates the process. Update
the Worker binding and roll the relays together: only one secret is accepted, so rotation can interrupt peer sessions.
Gatekeeper rechecks the secret every 60 seconds and grants only root QUIC/WebSocket peer sessions. Peer listeners use
public ACME server certificates; no client certificates are involved anywhere.

Deploy gatekeeper with secrets `MOQ_RELAY_TOKEN` and `MOQ_CLUSTER_TOKEN` set to the two keys, and make workload
deployment depend on that Worker deployment.

## Addon components

### `Addon`

`Addon` is the abstract component base for reusable host contributions. Concrete
addons implement `attachTo(context)` and return Compose services, volumes, files,
systemd units, deploy steps, endpoints, and optional summary values.

An addon has one of two scopes:

| Scope      | Deployment behavior                                                                                                                       |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `node`     | Deployed once per `Node` in a stable `/opt/vps-fleet/addons/<name>` Compose project, even if several workloads reuse that addon instance. |
| `workload` | Merged into every workload Compose project to which it is attached.                                                                       |

Reuse the same node-scoped addon object across workloads when it represents one host
service. Two different node-scoped addon instances that contribute the same name to a
shared node are rejected.

Custom addon constructors call the protected base constructor with their Pulumi type,
name, options, and scope. Per-node cloud resources created by `attachTo()` should use
the addon as their parent.

### `NetdataAddon`

Pulumi type: `fleet:core:NetdataAddon`

This node-scoped addon deploys Netdata in host network/PID mode with its persistent
volumes and host inspection mounts. Its private `netdata.http` endpoint listens on TCP
19999 and exposes `/api/v1/info`; because it is private it does not open cloud ingress.

The only optional argument is `image`, which defaults to `netdata/netdata:stable`. The
deploy step starts the container and waits for its local info endpoint. Reuse one
`NetdataAddon` instance across workloads to install one Netdata project per shared
node. The selected image is also registered as a Pulumi component output.

### `CloudflareMeshAddon`

Pulumi type: `fleet:core:CloudflareMeshAddon`

This node-scoped addon registers or consumes a Cloudflare Mesh/WARP connector and
deploys the official Mesh container with persistent state, source NAT, a systemd unit,
and an optional default-route safety check.

| Argument               | Required | Default/meaning                                                                        |
| ---------------------- | -------- | -------------------------------------------------------------------------------------- |
| `cloudflare.accountId` | yes      | Account in which connector resources are created.                                      |
| `image`                | no       | Library's digest-pinned official Mesh image.                                           |
| `sharedNodeToken`      | no       | External token to reuse instead of creating a connector per node. It is marked secret. |
| `hostnameRoutes`       | no       | Callback returning route intent for a node/context.                                    |
| `routeSafetyCheck`     | no       | Defaults to enabled; stops Mesh if it becomes the host default route.                  |
| `preflight`            | no       | Cloudflare preflight options.                                                          |

Without `sharedNodeToken`, `attachTo()` creates a high-availability WARP connector and
retrieves its secret token. Summary data includes node ID, name, status, and declared
hostname routes, which flow into workload summaries and relay directories.

The current Cloudflare Pulumi provider does not expose the 2026 hostname-route
resource. Declaring `hostnameRoutes` therefore emits an actionable warning; it records
intent but does not create those routes.

## Relay workload components

### `MoqRelayWorkload`

Pulumi type: `fleet:moq:RelayWorkload`

`MoqRelayWorkload` extends `ComposeWorkload` with a shared public ACME certificate,
shared callback and peer keys, explicit peer topology, MoQ 0.17.2 configuration,
health-gated deployment, and a relay directory.

| Argument                   | Required | Meaning                                                                  |
| -------------------------- | -------- | ------------------------------------------------------------------------ |
| `fleet`, `domain`          | yes      | Standard workload topology.                                              |
| `relays`                   | yes      | `{ node, peers? }` per relay; replaces `nodes`.                          |
| `acme`                     | yes      | Issues the shared public certificate.                                    |
| `image`                    | no       | Defaults to `moqdev/moq-relay:0.17.2`; accepts a digest-pinned override. |
| `authOrigin`               | yes      | Gatekeeper's HTTPS origin, without a path.                               |
| `authToken`                | yes      | Shared key relays present on admission callbacks.                        |
| `clusterToken`             | yes      | Shared peer secret: 32 bytes as lowercase hex.                           |
| `dns`, `addons`, `rollout` | no       | Same behavior as `ComposeWorkload`.                                      |

Gatekeeper authenticates callbacks with the shared auth key and validates the shared cluster secret for peer sessions.
Each relay's `peers` are other relays in the same workload; their URLs come from the fleet's hostnames and are
written into `cluster.connect`. Public TLS protects
peer connections; the `cluster.token` file supplies their credential. No client CA or peer JWT is required.

Public members inherited from `ComposeWorkload` include `nodes`, `summary`, and
`sshConfig`. MoQ-specific outputs are:

| Output                      | Meaning                                                      |
| --------------------------- | ------------------------------------------------------------ |
| `directory`                 | Relay discovery entries with URLs, endpoints, and Mesh data. |
| `clusterNodeUrls`           | Configured public cluster URLs.                              |
| `clusterPeersByNodeUrl`     | Every configured node URL mapped to its explicit peers.      |
| `publicCertificateNotAfter` | Shared public certificate expiry.                            |

The relay declares public TCP 443 (`moq.https`), public UDP 443
(`moq.webtransport`), and private TCP 9101 (`moq.prometheus`). Certificate changes use
a separate deploy trigger so renewal restarts can roll independently from image or
configuration changes.

### `IrohRelayWorkload`

Pulumi type: `fleet:iroh:RelayWorkload`

`IrohRelayWorkload` extends `ComposeWorkload` with a shared public ACME certificate,
Iroh configuration, health-gated deployment, and an Iroh relay directory.

| Argument                   | Required | Meaning                                                                    |
| -------------------------- | -------- | -------------------------------------------------------------------------- |
| `fleet`, `nodes`, `domain` | yes      | Standard workload topology.                                                |
| `acme`                     | yes      | Issues the shared public certificate.                                      |
| `image`                    | no       | Defaults to the digest-pinned `IROH_RELAY_IMAGE` (`v1.3.0`).               |
| `admissionUrl`             | yes      | Gatekeeper HTTPS URL ending in `/relays/iroh/admission`.                   |
| `admissionToken`           | yes      | Callback bearer token matching gatekeeper's `IROH_RELAY_TOKEN`.            |
| `ports`                    | no       | Overrides for HTTPS, QUIC discovery, metrics, and internal HTTP listeners. |
| `dns`, `addons`, `rollout` | no       | Same behavior as `ComposeWorkload`.                                        |

Default ports are HTTPS/TCP 443, QUIC discovery/UDP 7842, metrics/TCP 9090, and
loopback HTTP/TCP 8080. HTTPS, metrics, and HTTP TCP ports must be distinct. Override
HTTPS when colocating Iroh with another host-network workload that already owns TCP 443.

In addition to inherited members, it exposes:

| Output                      | Meaning                                                                    |
| --------------------------- | -------------------------------------------------------------------------- |
| `directory`                 | Iroh discovery entries with relay URLs, endpoints, and optional Mesh data. |
| `relayUrls`                 | Relay URLs projected from the directory.                                   |
| `publicCertificateNotAfter` | Shared public certificate expiry.                                          |

The relay uses `[access.http]` to ask gatekeeper whether each connecting endpoint has
an active lease. `admissionToken` is delivered through the secret
`IROH_RELAY_HTTP_BEARER_TOKEN` container environment variable, never through the
non-secret TOML file or client credentials. Token changes trigger a relay deployment.
This replaces the old `accessToken`/`access.shared_token` configuration; callers must
supply both new admission fields.

The callback uses bearer authentication, like the MoQ callback's shared auth key.
Iroh v1.3.0 checks access on connection; lease expiry or revocation refuses subsequent
connections but does not itself disconnect an already admitted session.

As with MoQ, certificate refresh is a separate deployment step from image/config
deployment.

## Composition patterns

### Generic Compose application

```ts
import * as pulumi from '@pulumi/pulumi';
import {
  CloudflareDnsRegistrar,
  ComposeWorkload,
  DigitalOceanProvider,
  Fleet,
  NetdataAddon,
  Node,
  composeUnit,
  healthCheckLoop
} from '@moq-ha/vps-fleet/core';

const fleet = new Fleet('fleet', {
  namePrefix: 'edge',
  environment: pulumi.getStack(),
  ssh: { port: 2222, allowedCidrs: ['203.0.113.10/32'] }
});

const machines = new DigitalOceanProvider('do', { fleet });
const dns = new CloudflareDnsRegistrar('dns', { zoneId });
const node = new Node('london', {
  fleet,
  provider: machines,
  providerRegion: 'lon1'
});
const netdata = new NetdataAddon('netdata');

const api = new ComposeWorkload('api', {
  fleet,
  nodes: [node],
  domain: 'example.com',
  dns,
  addons: [netdata],
  app: ({ hostname }) => ({
    name: 'api',
    dir: '/opt/api',
    services: {
      api: {
        image: 'ghcr.io/example/api:1.2.3@sha256:<digest>',
        restart: 'unless-stopped',
        ports: ['8080:8080']
      }
    },
    files: [],
    systemdUnits: [
      {
        path: '/etc/systemd/system/api.service',
        content: composeUnit('API', '/opt/api', ['api'])
      }
    ],
    endpoints: {
      'api.http': {
        service: 'api',
        port: 8080,
        transport: 'tcp',
        visibility: 'public',
        scheme: 'http',
        paths: { health: '/health' }
      }
    },
    deploySteps: [
      {
        name: 'deploy-api',
        script: `docker compose -f {{composeFile}} up -d api
${healthCheckLoop({ url: 'http://127.0.0.1:8080/health' })}`,
        triggers: ['ghcr.io/example/api:1.2.3@sha256:<digest>']
      }
    ],
    healthUrl: `http://${hostname}:8080/health`
  })
});
```

The endpoint causes TCP 8080 ingress to be added to the machine, the registrar creates
the node hostname, and `api.summary` describes the resolved endpoint.

### Shared node with MoQ and Iroh

The same `Node` can be passed to both workloads. An explicit machine hostname prevents
the first workload's domain from becoming the machine's long-term identity. Because
both apps use host networking, Iroh must move off TCP 443.

```ts
const shared = new Node('shared-london', {
  fleet,
  provider: machines,
  providerRegion: 'lon1',
  hostname: 'london.nodes.example.com'
});

const authToken = new random.RandomBytes('moq-relay-token', { length: 32 });
const clusterToken = new random.RandomBytes('moq-cluster-token', { length: 32, keepers: { generation: '1' } });
// Deploy gatekeeper with secrets MOQ_RELAY_TOKEN = authToken.hex and MOQ_CLUSTER_TOKEN = clusterToken.hex.
// The resulting gatekeeperDeployment resource is a prerequisite of the relay workload.
const moq = new MoqRelayWorkload(
  'moq',
  {
    fleet,
    relays: [{ node: shared }],
    domain: 'moq.example.com',
    dns,
    acme,
    image: moqImage,
    authOrigin: 'https://gatekeeper.example.com',
    authToken: pulumi.secret(authToken.hex),
    clusterToken: pulumi.secret(clusterToken.hex),
    addons: [netdata]
  },
  { dependsOn: [gatekeeperDeployment] }
);

const iroh = new IrohRelayWorkload('iroh', {
  fleet,
  nodes: [shared],
  domain: 'iroh.example.com',
  dns,
  acme,
  image: irohImage,
  admissionUrl: 'https://gatekeeper.example.com/relays/iroh/admission',
  admissionToken: irohToken,
  ports: { https: 8443 },
  addons: [netdata]
});
```

The node provisions one VPS. The Netdata instance is deployed once because the same
node-scoped addon object is reused. The MoQ and Iroh workload projects remain separate,
their DNS records point to the same machine, their firewall rules accumulate on that
machine, and the node sequences their remote deployments.

### Multiple providers

Providers are interchangeable at the `Node` boundary. A single workload can therefore
span DigitalOcean and OpenStack:

```ts
const nodes = [
  new Node('nyc', { fleet, provider: digitalOcean, providerRegion: 'nyc3' }),
  new Node('gra', { fleet, provider: ovhGra, providerRegion: 'GRA11' })
];

const workload = new ComposeWorkload('api', {
  fleet,
  nodes,
  domain: 'example.com',
  app: apiApp,
  rollout: 'serial'
});
```

Each provider translates the same SSH and endpoint-derived firewall intent into its
native resources. The workload still produces one summary and one SSH config across
both clouds.

## Outputs, secrets, and ownership

Use the aggregation helpers when exporting several workloads:

```ts
export const summary = fleetSummary({ workloads: [moq, iroh] });
export const sshConfig = sshConfigOutput({ fleet, workloads: [moq, iroh] });
export const sshPrivateKey = pulumi.secret(fleet.bootstrapSshKey.privateKeyPem);
```

The following values are credentials and should remain Pulumi secrets: bootstrap SSH
private keys, ACME account and certificate private keys, MoQ auth and cluster keys,
Iroh access tokens, and Mesh connector tokens. Use an encrypted Pulumi state backend and `pulumi stack output --show-secrets`
only when intentionally materializing a secret.

Pulumi parentage follows ownership rather than data flow. Machines are children of
nodes, per-workload hosts are children of node deployments, node-scoped addon hosts
are children of nodes, provider account resources are children of provider components,
and issuer-created certificates default to the issuer as parent. Passing explicit
provider resources through `ComponentResourceOptions.providers` lets their descendant
resources use non-ambient credentials.

## Related non-component building blocks

Several exported APIs participate in composition but are not library
`ComponentResource` classes:

- `DnsRegistrar` and `Machine` are provider-neutral interfaces.
- `ComposeApp`, `DeployStep`, `ServiceEndpointDefinition`, and `FirewallIntent` are the
  declarative contracts consumed by components.
- `moqRelayApp()` and `irohRelayApp()` build protocol-specific `ComposeApp` values.
- `renderCloudInitProfile()` creates the cloud-init custom resource used by `Node`.
- `composeUnit()`, `healthCheckLoop()`, `tcp()`, `udp()`, and `icmp()` are rendering or
  intent helpers.
- `fleetSummary()` and `sshConfigOutput()` aggregate component outputs without creating
  another component boundary.

These are documented here only to make the component graph understandable; they are
not additional Pulumi components.
