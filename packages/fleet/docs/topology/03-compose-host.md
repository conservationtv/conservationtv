# L2 — ComposeHost

> **Zoom:** [↓ L1 Leaf components](./02-leaf-components.md) · [↑ L3 Node](./04-node.md) · [⌂ Index](./README.md)

`ComposeHost` (`fleet:core:ComposeHost`) is the unit of **remote deployment**: one
Docker Compose project, written to one machine over SSH, then started by named
deploy steps. Every container the library runs is deployed through a ComposeHost.

There are two kinds of ComposeHost on a node:

| Kind              | Pulumi name                           | Parent           | Contents                                       |
| ----------------- | ------------------------------------- | ---------------- | ---------------------------------------------- |
| Workload host     | `<workload>-<node.id>-host`           | `NodeDeployment` | Workload `ComposeApp` + workload-scoped addons |
| Node addon host   | `<machineName>-<addon>-addon-host`    | `Node`           | One node-scoped addon, as its own `ComposeApp` |

## What it's made of

```mermaid
flowchart TB
  subgraph Inputs["Inputs"]
    M["Machine<br/>(address, sshUsers, resource)"]
    S["Fleet.ssh + bootstrap private key"]
    APP["ComposeApp"]
    ADD["workload-scoped HostAddonContribution[]"]
    DA["deployAfter: Resource[]"]
  end

  subgraph Eval["Evaluated in-process (no resources)"]
    V["validate app name (sanitized) and dir (absolute)"]
    MS["merge services · merge volumes<br/>(reject name collisions)"]
    ME["mergeServiceEndpoints → endpoints"]
    W["warn on mutable images"]
    F["file set = docker-compose.yml (0600)<br/>+ app files + addon files + systemd units<br/>composeFile token substituted · unique paths"]
  end

  subgraph CH["ComposeHost resources"]
    WAIT["remote.Command<br/>'…-wait-cloud-init'<br/>cloud-init status --wait"]
    FILES["remote.Command<br/>'…-files'<br/>one batched manifest"]
    ST1["remote.Command '…-‹step 1›'"]
    ST2["remote.Command '…-‹step 2›'"]
    STN["… one per DeployStep"]
  end

  APP & ADD --> V --> MS --> ME --> W --> F
  M -.->|"dependsOn machine.resource"| WAIT
  S -.-> WAIT
  WAIT --> FILES
  F -.-> FILES
  FILES --> ST1 & ST2 & STN
  DA -.->|"every step waits"| ST1 & ST2 & STN
  ST1 -.->|"dependsOnSteps"| ST2
```

Steps run in this order: **workload-scoped addon steps first, then the app's steps**.
A step can only depend on steps declared earlier, so `dependsOnSteps` cannot form a
cycle. Forward or unknown references fail at evaluation time.

`completionResources` is the full list of step commands. Higher levels use it as the
"this host is deployed and healthy" barrier for serial rollouts and node chaining
([L3](./04-node.md#deploy-chaining), [L5](./06-workloads.md#rollout)).

## A deploy, end to end

```mermaid
sequenceDiagram
  autonumber
  participant P as Pulumi engine
  participant C as Cloud API
  participant H as VPS (sshd on custom port)
  P->>C: create / confirm machine.resource
  P->>H: SSH as cloudInit user, cloud-init status --wait --long
  H-->>P: done (Docker installed, sshd moved)
  P->>H: SSH as deployment user, one script writes every file<br/>base64 heredocs, mkdir -p, chmod
  Note over P,H: re-runs only when some file content changes
  loop each DeployStep in order
    P->>H: set -eu + step script (sudo-wrapped on OpenStack)
    Note over H: typically systemctl enable,<br/>compose pull / up -d, healthCheckLoop
    H-->>P: exit 0, or fail the update
  end
```

## Deploy steps and triggers

`remote.Command` runs its script on **create** and whenever its **triggers** change.
Changing only a step's script text does not re-run it. Each app therefore decides what
should cause a restart. The relay apps define two steps:

```mermaid
flowchart LR
  subgraph Triggers1["deploy-relay triggers"]
    T1["image"]
    T2["relay.toml / iroh-relay.toml"]
    T3["clusterToken (MoQ) · admissionToken (Iroh)"]
  end
  subgraph Triggers2["refresh-relay-certs triggers"]
    T4["public fullchain + key"]
    T5["cluster token (MoQ)"]
  end
  Triggers1 --> D["deploy-relay<br/>daemon-reload · enable unit<br/>pull · up -d --force-recreate · health"]
  Triggers2 --> R["refresh-relay-certs<br/>restart relay · health"]
  D -.->|"dependsOnSteps"| R
```

The **file manifest** is a separate trigger boundary. A certificate renewal rewrites the
certificate files, because the manifest's triggers are every file's content, and then
runs only `refresh-relay-certs`. The image and configuration are not touched.

## What lands on the machine

```text
/opt/<app>/docker-compose.yml        0600  generated from merged services + volumes
/opt/<app>/...                        app files (configs, certs, secrets)
/etc/systemd/system/<app>.service     composeUnit(): pull + up -d at boot
/opt/vps-fleet/addons/<addon>/docker-compose.yml   node addon hosts
/usr/local/sbin/fleet-cloudflare-mesh-safety      Mesh addon only
```

The relay layouts at this level:

| App    | Dir         | Files                                                                                         | Unit           |
| ------ | ----------- | --------------------------------------------------------------------------------------------- | -------------- |
| `moq`  | `/opt/moq`  | `relay.toml`, `certs/public/node/{fullchain,privkey}.pem`, `secrets/cluster-token` | `moq.service`  |
| `iroh` | `/opt/iroh` | `iroh-relay.toml`, `certs/{fullchain,privkey}.pem`                                            | `iroh.service` |

## Safety checks at this level

The constructor throws on any of the following:

- invalid app name or a relative `dir`
- duplicate Compose service or volume names between the app and its addons
- duplicate remote file paths
- duplicate or invalid deploy-step names, or `dependsOnSteps` that point forward or to unknown steps
- endpoint problems from `mergeServiceEndpoints` ([L0](./01-primitives.md#3-network-intent-from-endpoints-to-firewall-rules))

These checks only cover **one** Compose project. Collisions *between* projects on the
same machine are the Node's job (next level).
