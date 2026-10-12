# Component reference

All components take `(name, args, opts?)`. Type tokens are `fleet:<entry point>:<Name>`: `fleet:core:*` for
`@moq-ha/vps-fleet`, `fleet:moq:RelayCluster` and `fleet:iroh:RelayCluster` for the relay entry points. A wrapper
forwards its `opts.dependsOn` to every remote command it creates, so `dependsOn: [gatekeeperDeploy]` on a relay cluster
holds back its rollout.

## Fleet and machines

### `Fleet`

Naming, SSH policy and the bootstrap SSH key (RSA 4096) shared by a set of machines.

| Arg           | Meaning                                                                             |
| ------------- | ----------------------------------------------------------------------------------- |
| `namePrefix`  | Prefix for cloud resource names and tags.                                           |
| `environment` | Second name/tag component, typically the stack name.                                |
| `ssh`         | `{ port, allowedCidrs }`. Port 22 is rejected; empty `allowedCidrs` means anywhere. |

Outputs: `publicKeyOpenSsh`, `privateKeyPem` (secret). Machines take the fleet as `fleet`; nothing else does.

### `DigitalOceanMachine`, `OpenStackMachine`

A VPS with its base firewall (fleet SSH ingress, all egress), booted with the fleet cloud-init profile. Both implement
`Machine`, the data every deployment consumes: `id`, `displayName`, `provider`, `region`, `hostname`, `address`,
`addressV6?`, `connection`, `sudo`, `ready` (cloud-init finished), `firewall` and `claims`.

Common args:

| Arg           | Meaning                                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `fleet`       | The `Fleet`.                                                                                                                 |
| `region`      | Provider region.                                                                                                             |
| `id`          | Lowercase DNS label, unique in the fleet. Defaults to the component name. Cloud names are `<namePrefix>-<environment>-<id>`. |
| `displayName` | Shown in relay directories. Defaults to `id`.                                                                                |
| `hostname`    | The machine's own FQDN. Defaults to `id`. Workload hostnames are DNS aliases and never change it.                            |
| `enableIpv6`  | Exposes `addressV6` and adds AAAA records.                                                                                   |
| `cloudInit`   | Extra `packages`, `files` and `commands`, run after Docker and sshd are set up.                                              |

DigitalOcean adds `size` (`s-1vcpu-2gb`), `image` (`ubuntu-24-04-x64`) and `sshKeys`. Create one `digitalocean.SshKey`
from `fleet.publicKeyOpenSsh` and pass its id to every machine: DigitalOcean rejects duplicate keys per account and
emails a root password to droplets created without one. OpenStack adds `flavor` (`d2-4`), `imageName`
(`Ubuntu 24.04`) and `networkName` (`Ext-Net`), owns a per-machine keypair and security group, and deploys as `ubuntu`
through sudo.

### `MachineIngress`

`{ firewall: FirewallTarget; rules: FirewallRule[] }`. Extra inbound rules on an existing machine, owned by whoever
creates it. `ComposeDeployment` creates one for its public endpoints; create your own for anything else. Build rules
with `tcp(port, cidrs?)`, `udp(port, cidrs?)` and `icmp(cidrs?)`; sources default to `ANYWHERE`.

### `renderSshConfig(machines, { aliasPrefix?, identityFile? })`

An OpenSSH config with one `Host <aliasPrefix>-<id>` block per machine. `identityFile` defaults to `./fleet-ssh.key`.

## Compose apps

### `ComposeApp`

A plain description of one Compose project; the lifecycle is generated from it.

| Field       | Meaning                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| `name`      | Sanitized name: the Compose project and `<name>.service` unit.                                        |
| `dir`       | Defaults to `/opt/<name>`.                                                                            |
| `services`  | Compose services. Values may be Pulumi inputs; secrets stay secret in the `0600` compose file.        |
| `volumes`   | Compose volumes.                                                                                      |
| `endpoints` | Listeners by id: `{ service, port, transport, visibility, binding?, scheme?, paths?, sourceCidrs? }`. |
| `files`     | `{ path, content, mode?, onChange? }`; relative paths resolve in `dir`, `mode` defaults to `0644`.    |
| `health`    | `{ url, expect? }` fetched on the machine after every redeploy or restart.                            |
| `steps`     | `{ name, script, triggers }` escape hatches, run in `dir` after the managed lifecycle.                |

`visibility` is `public` (opens the firewall for `sourceCidrs`, default anywhere), `private` or `loopback` (closed).
`binding: 'host'` (default) means the listener is bound on the machine and is claimed there; host-network services must
declare every listener so collisions are caught. `onChange` is `redeploy` (default), `restart` or `none`.

### `ComposeDeployment`

`{ target: { machine, hostname, priority? }, app, ingress?, dns? }`. One app on one machine: claims its listeners,
paths and container names on `machine.claims`, opens firewall rules for public host endpoints plus `ingress`, runs the
lifecycle after `machine.ready`, and creates `AddressRecords` for `hostname` when `dns` is set.

Remote commands: `<name>-files` writes every file; `<name>-redeploy` reloads systemd, enables the unit, pulls,
recreates and health-gates (triggered by `redeploy` files, always including the compose file and unit);
`<name>-restart` restarts in place and health-gates (triggered by `restart` files only); `<name>-step-<step>` follows.

Outputs: `target`, `app`, `endpoints` (resolved, with `owner`, `binding`, `targetPort`), `summary`.

### `ComposeWorkload`

`{ targets, app, ingress?, dns?, rollout? }`. A `ComposeDeployment` named `<name>-<machine id>` per target, ordered by
`priority` then machine id. `app` may be a function of the target. `rollout: 'serial'` makes each deployment wait for
the previous one, health gates included. Outputs: `deployments`, `summary`.

`requireEndpoint(endpoints, id)` and `endpointUrl(endpoint, hostname, path?)` build URLs from resolved endpoints,
omitting default ports.

### `AddressRecords`

`{ zone: { provider: 'cloudflare', zoneId, ttl? }, hostname, address, addressV6? }`. Unproxied A and optional AAAA
records, TTL 60 by default.

## TLS

### `AcmeAccount`

`{ serverUrl, email?, dnsChallenge: { provider: 'cloudflare', apiToken } }`. An ACME provider, a P-256 account key and
its registration. The DNS token is stored as a secret.

### `AcmeCertificate`

`{ account, names, minDaysRemaining? }`. A P-256 certificate for `names` (the first is the common name, at most 64
characters; one leading `*.` label is allowed) via DNS-01, renewed by `pulumi up` when fewer than `minDaysRemaining`
(30) days remain. Implements `PublicTlsMaterial`: `fullchainPem`, `privateKeyPem`, plus `notAfter`.

## Relays

### `MoqRelayCluster` (`@moq-ha/vps-fleet/moq`)

| Arg       | Meaning                                                                                         |
| --------- | ----------------------------------------------------------------------------------------------- |
| `relays`  | `{ machine, hostname, priority?, peers? }`; `peers` are other relays' machines in this cluster. |
| `tls`     | Must cover every relay hostname.                                                                |
| `auth`    | `{ origin, token, clusterToken }`, see below.                                                   |
| `dns`     | Optional `DnsZone` for relay hostnames.                                                         |
| `image`   | Defaults to `MOQ_RELAY_IMAGE` (`moqdev/moq-relay:0.17.2`).                                      |
| `rollout` | `parallel` (default) or `serial`.                                                               |

Each relay serves HTTPS on TCP 443 (`moq.https`), WebTransport on UDP 443 (`moq.webtransport`) and Prometheus on private
TCP 9101 (`moq.prometheus`), and dials its peers at `https://<hostname>/`. The cluster id derives from the machine id.

Outputs: `directory` (per relay: `id`, `region`, `providerRegion`, `priority`, `publicHostname`, `publicAddress`,
`endpoints`, `connectUrl`, `webtransportUrl`, `publicHealthUrl`), `clusterNodeUrls`, `clusterPeersByNodeUrl`, `summary`.

**Admission callbacks.** `auth.token` is a shared key the relays present to gatekeeper: generate 32 bytes with
`random.RandomBytes` and pass its hex; it is gatekeeper's `MOQ_RELAY_TOKEN`. moq-relay 0.17.2 has no header setting for
its auth callout, so the key is userinfo in the callback URL (`https://moq-relay:<key>@<origin>/relays/moq/admission`),
sent as HTTP Basic credentials. The URL travels in the `MOQ_AUTH_URL` environment variable inside the `0600` compose
file, never in the world-readable `relay.toml`. `auth.origin` must be an HTTPS origin without a path.

**Peer sessions.** `auth.clusterToken` is a second shared key, 32 bytes as lowercase hex (not a JWT), and is
gatekeeper's `MOQ_CLUSTER_TOKEN`. Each relay reads it from `/opt/moq/secrets/cluster-token` (`0600`). Rotate it
explicitly with a `keepers` value; a change redeploys the relays. Only one token is accepted at a time, so update the
gatekeeper binding and roll the relays together; peer sessions may drop during rotation. Gatekeeper rechecks the token
every 60 seconds and grants only root QUIC/WebSocket peer sessions. Peers authenticate servers with the public ACME
certificate; no client certificates are involved.

Both keys change the relays' compose file or secret file, so rotating either redeploys. Deploy gatekeeper with both
secrets first and pass that deployment in the cluster's `dependsOn`.

### `IrohRelayCluster` (`@moq-ha/vps-fleet/iroh`)

| Arg                       | Meaning                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------- |
| `relays`                  | `{ machine, hostname, priority? }`.                                                 |
| `tls`                     | Must cover every relay hostname.                                                    |
| `admission`               | `{ url, token }`: gatekeeper's HTTPS `/relays/iroh/admission` URL and bearer token. |
| `ports`                   | Overrides `{ https: 443, quicDiscovery: 7842, metrics: 9090, http: 8080 }`.         |
| `dns`, `image`, `rollout` | As for MoQ; `image` defaults to the digest-pinned `IROH_RELAY_IMAGE` (`v1.3.0`).    |

HTTPS (`iroh.https`) and QUIC discovery (`iroh.quic-discovery`) are public, metrics (`iroh.metrics`) private and the
internal HTTP listener (`iroh.http`) loopback. HTTPS, metrics and HTTP must use distinct TCP ports; move HTTPS off 443 to
share a machine with MoQ.

Outputs: `directory` (common fields plus `relayUrl`), `relayUrls`, `summary`.

**Admission.** The relay asks gatekeeper about every connecting endpoint (`[access.http]`) and admits only a `200 true`
response. `admission.token` is gatekeeper's `IROH_RELAY_TOKEN`; it reaches the relay as the
`IROH_RELAY_HTTP_BEARER_TOKEN` environment variable in the `0600` compose file, never in the TOML or in client
credentials, and a change redeploys. Iroh v1.3.0 checks access on connection only: an expired or revoked lease refuses
new connections but does not end an admitted session.

`moqRelayApp()` and `irohRelayApp()` return the underlying `ComposeApp`s for custom placements;
`renderMoqRelayToml()` and `renderIrohRelayToml()` render the relay configuration alone.

## Node services

### `NetdataAgent`

`{ machines, image? }`. Netdata in host network and PID mode on each machine (`/opt/netdata`), with a private
`netdata.http` endpoint on TCP 19999. `image` defaults to `netdata/netdata:stable`. Output: `summary`.

### `CloudflareMeshConnector`

| Arg                | Meaning                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| `machines`         | Machines to join.                                                                              |
| `accountId`        | Cloudflare account for the connectors.                                                         |
| `sharedNodeToken`  | Join every machine with one existing token instead of creating a WARP connector per machine.   |
| `hostnameRoutes`   | `(machine) => string[]`. Validated, then warned about: the provider cannot create them yet.    |
| `routeSafetyCheck` | Default `true`: stops the mesh if it captures the host's default route, at deploy and on boot. |
| `image`            | Defaults to a digest-pinned official image.                                                    |

Runs the official `cloudflare/mesh` container (`/opt/cloudflare-mesh`) with persistent state and source NAT. Output:
`connectors`, keyed by machine id (`id`, `name`, `status`, `hostnameRoutes`).

## Extending

Implement `Machine` to add a provider: expose a `connection`, a `ready` resource and a `MachineClaimLedger` as
`claims`. `FirewallTarget` is a closed union (DigitalOcean or OpenStack), so a provider with a new firewall model also
needs a `MachineIngress` case. Build new node services or protocol clusters as
components that create a `ComposeWorkload` with `{ parent: this, dependsOn: opts?.dependsOn }`.
