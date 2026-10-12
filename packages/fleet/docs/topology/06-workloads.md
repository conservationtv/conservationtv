# L5 — Workloads

> **Zoom:** [↓ L4 NodeDeployment](./05-node-deployment.md) · [↑ L6 Fleet](./07-fleet.md) · [⌂ Index](./README.md)

A workload is **one application across many nodes**. It forms a row of the
workload × node grid. `ComposeWorkload` is the generic version. `MoqRelayWorkload` and
`IrohRelayWorkload` subclass it: they prepare protocol-specific inputs, then pass the
per-node work to the base class.

```mermaid
flowchart TB
  CW["ComposeWorkload<br/>fleet:core:ComposeWorkload"]
  MW["MoqRelayWorkload<br/>fleet:moq:RelayWorkload"]
  IW["IrohRelayWorkload<br/>fleet:iroh:RelayWorkload"]
  MW -->|"extends"| CW
  IW -->|"extends"| CW
  CW -->|"one per node"| ND["NodeDeployment × N (L4)"]
  MW -.->|"app = moqRelayApp()"| CW
  IW -.->|"app = irohRelayApp()"| CW
```

## ComposeWorkload

```mermaid
flowchart TB
  IN["args: fleet · nodes · domain · app factory<br/>dns? · ingress? · addons? · rollout?"]
  O["sort nodes by priority, then id"]
  V1["every node.fleet === fleet"]
  H["hostname per node = fleet.hostnameFor(node, domain)"]
  V2["validateNodes: ≥1 node · valid unique ids · unique hostnames"]
  LOOP["for each node in order<br/>new NodeDeployment(‹workload›-‹node.id›, parent: this)"]
  AGG["summary = all node summaries<br/>sshConfig = Host blocks for every node"]
  IN --> O --> V1 --> H --> V2 --> LOOP --> AGG
```

| Member         | Shape                                     |
| -------------- | ----------------------------------------- |
| `workloadName` | component name                            |
| `nodes`        | `Map<node.id, NodeDeployment>`            |
| `summary`      | `Output<WorkloadNodeSummary[]>` in rollout order |
| `sshConfig`    | `Output<string>` of OpenSSH `Host` blocks |

### Rollout

```mermaid
flowchart LR
  subgraph Parallel["rollout: parallel (default)"]
    direction TB
    PA["na-east steps"]
    PB["eu-gra steps"]
    PC["eu-west steps"]
  end
  subgraph Serial["rollout: serial"]
    direction LR
    SA["na-east steps<br/>(priority 0)"] -->|"completionResources"| SB["eu-gra steps<br/>(priority 1, eu-gra sorts before eu-west)"] -->|"completionResources"| SC["eu-west steps<br/>(priority 1)"]
  end
```

Serial rollout chains only the **deploy steps** of each node's workload host. Machines,
cloud-init waits, file writes, firewalls, and DNS still proceed in parallel. Because
relay deploy steps end with a health check, serial means "node *n+1* updates only after
node *n* is healthy".

## MoqRelayWorkload

```mermaid
flowchart TB
  subgraph Inputs
    ACME["AcmeIssuer"]
    ARGS["fleet · relays[]: {node, peers?} · domain<br/>authOrigin · authToken · clusterToken · image? · dns? · addons? · rollout?"]
  end
  CERT["acme.Certificate ‹workload›-public<br/>CN=domain · SAN nodes.domain, *.nodes.domain"]
  CHK["validate peers are other relays in this workload<br/>peer URL = https://‹fleet.hostnameFor(peer)›/"]
  APP["per node: moqRelayApp({<br/>nodeId, hostname, image,<br/>authOrigin, authToken,<br/>peers=relay.peers URLs,<br/>clusterToken, publicTls=cert})"]
  BASE["ComposeWorkload (base)"]
  DIR["directory = buildMoqDirectory(deployments)<br/>connectUrl · webtransportUrl · publicHealthUrl · mesh"]
  ACME --> CERT --> APP
  ARGS --> CHK --> APP
  ARGS --> BASE
  APP --> BASE --> DIR
```

**Peers come from the workload's `relays`.** Each relay lists the other relay nodes it dials;
the workload rejects peers outside the workload, self-references and repeats, and derives peer URLs from fleet
hostnames. The exported `moqCluster()` helper computes a full-mesh topology if you want to compare against it.

### MoQ runtime topology

```mermaid
flowchart LR
  CL["Clients"] -->|"tcp/443 HTTPS · udp/443 WebTransport"| R1
  subgraph Fleet["MoQ relays"]
    R1["relay na-east"]
    R2["relay eu-west"]
    R3["relay eu-gra"]
  end
  R1 <-->|"cluster.connect · TLS + cluster-token"| R2
  R2 <-->|"cluster.connect"| R3
  R1 <-->|"cluster.connect"| R3
  R1 & R2 & R3 -->|"auth callback · Basic auth key<br/>‹origin›/relays/moq/admission"| GK["gatekeeper Worker<br/>MOQ_RELAY_TOKEN · MOQ_CLUSTER_TOKEN"]
```

## IrohRelayWorkload

```mermaid
flowchart TB
  ACME["AcmeIssuer"] --> CERT["acme.Certificate ‹workload›-public"]
  ARGS["admissionUrl · admissionToken (secret) · ports?"] --> APP
  CERT --> APP["per node: irohRelayApp({hostname, image, admissionUrl, admissionToken, publicTls, ports})"]
  APP --> BASE["ComposeWorkload (base)"]
  BASE --> DIR["directory = buildIrohDirectory(deployments) → relayUrls"]
```

### Iroh runtime topology

```mermaid
flowchart LR
  CL["Iroh endpoints"] -->|"tcp/https port · udp/7842 QUIC discovery"| R["iroh relay (each node)"]
  R -->|"[access.http] per connecting endpoint<br/>Bearer IROH_RELAY_HTTP_BEARER_TOKEN"| GK["gatekeeper<br/>/relays/iroh/admission<br/>IROH_RELAY_TOKEN"]
  GK -->|"200 true → admit"| R
```

Iroh relays don't peer with each other. Each node is an independent relay, listed in
`relayUrls`.

## Side-by-side

|                        | `ComposeWorkload`     | `MoqRelayWorkload`                                     | `IrohRelayWorkload`                                         |
| ---------------------- | --------------------- | ------------------------------------------------------ | ----------------------------------------------------------- |
| App                    | your factory          | `moqRelayApp`                                          | `irohRelayApp`                                              |
| Default image          | —                     | `moqdev/moq-relay:0.17.2`                              | `n0computer/iroh-relay:v1.3.0@sha256:…`                     |
| Extra inputs           | —                     | `acme`, `authOrigin`, `authToken`, `clusterToken`      | `acme`, `admissionUrl`, `admissionToken`, `ports`           |
| Public endpoints       | yours                 | tcp/443 `moq.https`, udp/443 `moq.webtransport`        | tcp/443 `iroh.https`, udp/7842 `iroh.quic-discovery`        |
| Private / loopback     | yours                 | tcp/9101 `moq.prometheus`                              | tcp/9090 `iroh.metrics`, tcp/8080 `iroh.http` (loopback)    |
| Inter-node traffic     | —                     | full or partial mesh via `cluster.connect`             | none                                                        |
| Gatekeeper callback    | —                     | Shared key as HTTP Basic credentials                   | Bearer token                                                |
| Deploy steps           | yours                 | `deploy-relay`, `refresh-relay-certs`                  | `deploy-relay`, `refresh-relay-certs`                       |
| Extra outputs          | —                     | `directory`, `clusterNodeUrls`, `clusterPeersByNodeUrl`, `publicCertificateNotAfter` | `directory`, `relayUrls`, `publicCertificateNotAfter` |

## Ownership note

The workload is the Pulumi parent of its NodeDeployments, and through them of each
workload host and DNS record. Its public certificate is a child of the **AcmeIssuer**,
not the workload. MoQ auth and cluster keys are plain `random.RandomBytes` passed in by the caller.
