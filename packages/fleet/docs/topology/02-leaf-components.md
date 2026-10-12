# L1 — Leaf components

> **Zoom:** [↓ L0 Primitives](./01-primitives.md) · [↑ L2 ComposeHost](./03-compose-host.md) · [⌂ Index](./README.md)

A leaf component is a Pulumi `ComponentResource` that contains only raw provider
resources (TLS keys, droplets, DNS records, and so on), not other library components.
Each one wraps a single concern and is handed to higher levels as a dependency.

```mermaid
flowchart LR
  subgraph Identity["Access"]
    SSH["BootstrapSshKey<br/>fleet:core:BootstrapSshKey"]
  end
  subgraph Compute["Compute"]
    MP["MachineProvider (abstract)"]
    DOP["DigitalOceanProvider"]
    OSP["OpenStackProvider"]
    MC["MachineComponent<br/>fleet:core:Machine"]
    MP --> DOP & OSP
    DOP -->|"createMachine()"| MC
    OSP -->|"createMachine()"| MC
  end
  subgraph Naming["Naming and TLS"]
    DNS["CloudflareDnsRegistrar<br/>implements DnsRegistrar"]
    ACME["AcmeIssuer"]
  end
  subgraph Addons["Host services"]
    AD["Addon (abstract)"]
    ND["NetdataAddon · scope=node"]
    MESH["CloudflareMeshAddon · scope=node"]
    AD --> ND & MESH
  end

  SSH -.->|"public key"| DOP & OSP
  SSH -.->|"private key"| CH["L2 ComposeHost"]
  MC -.->|"Machine"| NODE["L3 Node"]
  DNS -.->|"createAddressRecords()"| NDP["L4 NodeDeployment"]
  Addons -.->|"attachTo() → contribution"| NDP
  ACME -.->|"issueCertificate()"| WL["L5 Relay workloads"]
```

Each component below shows what it creates (solid lines), the Pulumi resource names it
uses, and what it exposes.

---

## BootstrapSshKey

```mermaid
flowchart LR
  K["BootstrapSshKey<br/>'‹fleet›-bootstrap-ssh'"] --> P["tls.PrivateKey<br/>RSA 4096<br/>'…-key'"]
  P -.->|"publicKeyOpenSsh"| U1["provider key resources<br/>cloud-init authorized_keys"]
  P -.->|"privateKeyPem (secret)"| U2["ComposeHost SSH connection<br/>stack output sshPrivateKey"]
```

`Fleet` creates exactly one, as its child. It is the only credential that can SSH into
machines; there is no per-node key.

## MachineProvider → MachineComponent

`MachineProvider` is the adapter boundary between the provider-neutral world
(`MachineArgs`, `FirewallIntent`) and a specific cloud. A provider's
`createMachine(name, args, {parent: node})` returns a `MachineComponent` that wraps the
cloud-specific resources and implements the `Machine` interface:

| `Machine` member    | Purpose                                                                               |
| ------------------- | ------------------------------------------------------------------------------------- |
| `address`           | IPv4 address, used for SSH, DNS A records, summaries                                   |
| `addressV6?`        | IPv6 address, only when `Node.enableIpv6`; becomes AAAA records                        |
| `sshUsers`          | `{cloudInit, deployment}`: `root` on DigitalOcean, `ubuntu` (+sudo) on OpenStack      |
| `resource`          | The real cloud resource; `ComposeHost` waits on it                                     |
| `addIngress()`      | Adds more firewall policy to the **existing** machine; called once per workload       |

### DigitalOceanProvider

```mermaid
flowchart TB
  subgraph DOP["DigitalOceanProvider · fleet:core:DigitalOceanProvider"]
    KEY["digitalocean.SshKey<br/>'‹do›-bootstrap'"]
    TAGS["digitalocean.Tag × 3 per machine<br/>(deduped across machines)"]
  end
  subgraph MC["MachineComponent '‹node›-machine' (child of Node)"]
    DROP["digitalocean.Droplet<br/>image ubuntu-24-04-x64 · size s-1vcpu-2gb<br/>monitoring · ipv6? · userData=cloud-init"]
    FW0["digitalocean.Firewall '…-firewall'<br/>inbound: SSH port from allowedCidrs<br/>outbound: all tcp/udp/icmp"]
  end
  FWN["digitalocean.Firewall '‹node›-‹workload›-ingress'<br/>(one per workload, child of Node)<br/>inbound: endpoint-derived rules"]
  KEY -.-> DROP
  TAGS -.-> DROP
  TAGS -.->|"tag ‹prefix›-‹machineName›"| FW0 & FWN
  DROP -.->|"dependsOn"| FWN
```

A single DigitalOcean provider can serve any number of regions, because the droplet
region comes from `Node.providerRegion`. Firewalls attach by **tag**, so each workload's
ingress is a separate `Firewall` resource that targets the same droplet. If a workload
has no public endpoints, it creates no firewall.

### OpenStackProvider

```mermaid
flowchart TB
  subgraph OSP["OpenStackProvider · fleet:core:OpenStackProvider (one per region)"]
    KP["openstack.compute.Keypair<br/>'‹os›-bootstrap'"]
  end
  subgraph MC["MachineComponent '‹node›-machine' (child of Node)"]
    SG["networking.SecGroup<br/>deleteDefaultRules=true"]
    R0["SecGroupRule × (intent × CIDR)<br/>ingress: SSH · egress: all"]
    INST["compute.Instance<br/>image 'Ubuntu 24.04' · flavor d2-4<br/>network Ext-Net · userData=cloud-init"]
  end
  RN["SecGroupRule × (intent × CIDR)<br/>per workload, child of Node"]
  KP -.-> INST
  SG --> R0
  SG -.-> INST
  R0 -.->|"dependsOn"| INST
  SG -.->|"securityGroupId"| RN
```

An OpenStack provider is pinned to one region and rejects nodes in any other, so a
multi-region OpenStack fleet needs one provider component per region. Each
`FirewallIntent` expands into one rule per CIDR, with `IPv4` or `IPv6` ethertype chosen
from the CIDR.

## CloudflareDnsRegistrar

```mermaid
flowchart LR
  R["CloudflareDnsRegistrar<br/>zoneId · ttl=60"] -->|"createAddressRecords(name, {hostname, address, addressV6?})"| A["cloudflare.DnsRecord A<br/>'‹deployment›-dns-a'<br/>proxied=false"]
  R --> AAAA["cloudflare.DnsRecord AAAA<br/>'‹deployment›-dns-aaaa'<br/>only if IPv6"]
```

The registrar owns no resources of its own. Records are parented to the calling
`NodeDeployment`, so deleting a workload removes its DNS records. Any object that
implements the `DnsRegistrar` interface can replace it.

## AcmeIssuer

```mermaid
flowchart TB
  subgraph I["AcmeIssuer · fleet:core:AcmeIssuer"]
    PR["acme.Provider<br/>serverUrl"]
    AK["tls.PrivateKey<br/>P-256 account key"]
    REG["acme.Registration"]
    C1["acme.Certificate 'moq-public'"]
    C2["acme.Certificate 'iroh-public'"]
    AK --> REG
    PR -.-> REG
    REG -.-> C1 & C2
  end
  CF["Cloudflare DNS-01<br/>CLOUDFLARE_DNS_API_TOKEN (secret)"] -.-> C1 & C2
  C1 -.->|"fullchainPem · privateKeyPem · notAfter"| W1["MoqRelayWorkload"]
  C2 -.-> W2["IrohRelayWorkload"]
```

`issueCertificate()` adds a certificate as a child of the issuer. Each relay workload
requests one certificate for `<domain>`, `nodes.<domain>`, and `*.nodes.<domain>`. One
certificate covers every node in the workload. With `minDaysRemaining: 30` (the
default), any `pulumi up` within 30 days of expiry renews it.

## Addons

An `Addon` is created once with `new` and then attached to any number of nodes through
workloads. `attachTo(context)` returns a `HostAddonContribution`
([L0](./01-primitives.md#4-host-contracts)). Any per-node cloud resources the addon
needs are created as **children of the addon**.

```mermaid
flowchart LR
  subgraph Netdata["NetdataAddon · scope=node"]
    NC["contribution 'netdata'<br/>service netdata (host net + host pid)<br/>volumes · endpoint netdata.http tcp/19999 private<br/>step deploy-netdata"]
  end
  subgraph Mesh["CloudflareMeshAddon · scope=node"]
    WC["cloudflare.ZeroTrustTunnelWarpConnector<br/>'‹machine›-connector' (per node)<br/>skipped if sharedNodeToken"]
    TK["getZeroTrustTunnelWarpConnectorToken"]
    MC2["contribution 'cloudflare-mesh'<br/>service + /dev/net/tun · NET_ADMIN<br/>safety script · systemd unit<br/>step deploy-cloudflare-mesh<br/>summary {nodeId, nodeName, nodeStatus}"]
    WC --> TK -.->|"MESH_NODE_TOKEN"| MC2
  end
```

| Scope      | Where it's deployed                                                          | Dedup rule                                       |
| ---------- | ---------------------------------------------------------------------------- | ------------------------------------------------ |
| `node`     | Its own Compose project at `/opt/vps-fleet/addons/<name>`, parented to Node  | Same addon **instance** → deployed once per node |
| `workload` | Merged into each workload's Compose project                                  | Deployed with every workload                     |

Both built-in addons are node-scoped. Reuse one instance across workloads so a shared
node gets a single Netdata and a single Mesh connector. The deduplication is
implemented by the Node ([L3](./04-node.md#node-scoped-addon-deduplication)).
