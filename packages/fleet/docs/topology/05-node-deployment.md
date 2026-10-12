# L4 — NodeDeployment

> **Zoom:** [↓ L3 Node](./04-node.md) · [↑ L5 Workloads](./06-workloads.md) · [⌂ Index](./README.md)

A `NodeDeployment` (`fleet:core:NodeDeployment`) is **one workload on one node**, a
single cell in the workload × node grid. It is the level where every lower piece is
assembled: addons ([L1](./02-leaf-components.md#addons)), the app contract and endpoint
pipeline ([L0](./01-primitives.md)), the Node ([L3](./04-node.md)), ComposeHosts
([L2](./03-compose-host.md)), and DNS ([L1](./02-leaf-components.md#cloudflarednsregistrar)).

Pulumi name: `<workload>-<node.id>`, for example `moq-na-east`.

## What it's made of

```mermaid
flowchart TB
  subgraph ND["NodeDeployment moq-na-east"]
    direction TB
    H["ComposeHost moq-na-east-host<br/>(workload app + workload-scoped addons)"]
    DA["cloudflare.DnsRecord moq-na-east-dns-a"]
    DAAAA["cloudflare.DnsRecord moq-na-east-dns-aaaa (IPv6 only)"]
    SUM["summary · sshAlias · endpoints"]
  end
  subgraph NodeOwned["created during construction, parented to the Node"]
    I["‹machine›-moq-ingress"]
    AH1["‹machine›-netdata-addon-host"]
    AH2["‹machine›-cloudflare-mesh-addon-host"]
    M["‹machine›-machine (first attach only)"]
  end
  ND -.->|"node.attach()"| I & M
  ND -.->|"new ComposeHost(parent: node)"| AH1 & AH2
```

Some resources this deployment causes to exist are **owned by the Node**, not by the
deployment. This is what lets a machine and its shared addons outlive any single
workload.

## The construction pipeline

Everything below runs synchronously in the constructor, in this order:

```mermaid
flowchart TB
  S1["1 · attach each addon via node.attachAddon()<br/>→ contributions (all) · workloadContributions · nodeAddonApps (new node-scoped only)"]
  S2["2 · app = appFactory({fleet, node, workloadName, hostname})"]
  S3["3 · endpoints = merge(app + ALL contributions)<br/>for summaries and directories"]
  S4["4 · deployedEndpoints = merge(app + workload contributions + new node addon apps)<br/>for ingress and claims"]
  S5["5 · ingress = mergeFirewallIntents(public host endpoints + workload.ingress)"]
  S6["6 · claims = paths + container names of app, workload addons, new node addon apps"]
  S7["7 · node.attach(...) → machine, deployAfter<br/>(creates the machine on first attach · adds ingress)"]
  S8["8 · ComposeHost per new node addon, chained one after another (parent: Node)"]
  S9["9 · workload ComposeHost (parent: this)<br/>deployAfter = serial predecessor + node chain"]
  S10["10 · node.completeAttachment(workload, host)"]
  S11["11 · dns.createAddressRecords(hostname → machine.address / addressV6)"]
  S12["12 · summary output"]
  S1 --> S2 --> S3 --> S4 --> S5 --> S6 --> S7 --> S8 --> S9 --> S10 --> S11 --> S12
```

### Why there are two endpoint catalogs

| Catalog               | Includes reused node addons? | Used for                                             |
| --------------------- | ---------------------------- | ---------------------------------------------------- |
| `endpoints`           | **yes**                      | `summary.endpoints`, MoQ/Iroh directories            |
| `deployedEndpoints`   | no (only ones this deployment deploys) | firewall ingress, Node listener claims     |

The second workload on a shared node still *reports* `netdata.http`, but does not claim
tcp/19999 again. Claiming it twice would collide with the first workload's claim on
the same listener.

## Dependency graph of one deployment

```mermaid
flowchart LR
  MR["machine.resource"] --> W["host: wait-cloud-init"] --> F["host: files"]
  ING["ingress resources"] --> AH1["netdata addon host steps"] --> AH2["mesh addon host steps"] --> STEPS["host: deploy steps"]
  PREV["Node.previousDeployment<br/>(earlier workload on this node)"] --> AH1
  SER["serial predecessor's<br/>completionResources"] --> STEPS
  F --> STEPS
  MR -.->|"address output"| DNS["DNS A / AAAA"]
```

DNS records depend only on the machine's address. **They are not gated on health
checks.** A hostname can resolve before its relay passes `healthCheckLoop`. With
`ttl: 60` and an unproxied record, clients may reach the new IP during the first
deploy before the service is ready.

## Summary and SSH alias

```ts
// NodeDeployment.summary
{
  id, provider, providerRegion, priority,
  hostname,            // workload hostname, not necessarily the machine FQDN
  address, addressV6?,
  healthUrl?,          // from ComposeApp.healthUrl
  endpoints,           // full catalog incl. reused node addons
  mesh?: { nodeId, nodeName, status }   // when a 'cloudflare-mesh' contribution exists
}
// NodeDeployment.sshAlias → "<prefix>-<workload>-<node.id>"
```

Two deployments on the same machine produce two SSH aliases (`edge-moq-na-east` and
`edge-iroh-na-east`) that point at the same address.

## Using it directly

Construct `NodeDeployment` directly only when you need a single cell without
`ComposeWorkload`'s fleet-membership check, priority ordering, hostname uniqueness,
serial rollout, and aggregation. In every other case, let a workload create it.
