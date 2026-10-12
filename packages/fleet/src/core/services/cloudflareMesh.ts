import * as cloudflare from '@pulumi/cloudflare';
import * as pulumi from '@pulumi/pulumi';
import { ComposeWorkload } from '../compose/workload';
import type { ComposeApp, Machine, WorkloadTarget } from '../contracts';
import { sanitizeName } from '../naming';
import { isDnsLabel } from '../validate';

const DEFAULT_IMAGE =
  'docker.io/cloudflare/mesh:2026.7.0@sha256:18fad6d500e8ca48b7e4d5ae1905d65e8a50c1f5f5e21eba020d54d5cbf82571';
const APP = 'cloudflare-mesh';
const SAFETY_SCRIPT_PATH = '/usr/local/sbin/fleet-cloudflare-mesh-safety';

export interface CloudflareMeshConnectorArgs {
  machines: Machine[];
  accountId: pulumi.Input<string>;
  image?: string;
  /** Join every machine with one existing token instead of creating a connector per machine. */
  sharedNodeToken?: pulumi.Input<string>;
  /** Hostname routes each machine should serve. Validated and warned about only: the provider cannot create them yet. */
  hostnameRoutes?: (machine: Machine) => string[];
  /** Stop the mesh if it captures the host's default route. Defaults to true. */
  routeSafetyCheck?: boolean;
}

export interface CloudflareMeshNode {
  /** Connector id, or `external` when a shared token is used. */
  id: string;
  name: string;
  status: string;
  hostnameRoutes: string[];
}

/** Joins each machine to Cloudflare Mesh (WARP connector) with source NAT for its private traffic. */
export class CloudflareMeshConnector extends pulumi.ComponentResource {
  /** Keyed by machine id. */
  public readonly connectors: pulumi.Output<Record<string, CloudflareMeshNode>>;

  /** Validates the machine list and routes, gets each machine a token, then deploys the mesh app everywhere. */
  public constructor(name: string, args: CloudflareMeshConnectorArgs, opts?: pulumi.ComponentResourceOptions) {
    super('fleet:core:CloudflareMeshConnector', name, {}, opts);
    if (args.machines.length === 0) throw new Error(`CloudflareMeshConnector "${name}" needs at least one machine.`);
    const ids = args.machines.map(machine => machine.id);
    const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
    if (duplicate) throw new Error(`CloudflareMeshConnector "${name}" lists machine "${duplicate}" twice.`);

    const image = args.image ?? DEFAULT_IMAGE;
    const nodes = new Map(
      args.machines.map(machine => {
        const hostnameRoutes = [...new Set((args.hostnameRoutes?.(machine) ?? []).map(normalizeHostnameRoute))];
        if (hostnameRoutes.length > 0) {
          pulumi.log.warn(
            `Cloudflare hostname routes for ${machine.id} (${hostnameRoutes.join(', ')}) are declared but ` +
              '@pulumi/cloudflare does not expose the hostname-route resource yet; create them through the ' +
              'Cloudflare dashboard/API.',
            this
          );
        }
        return [machine.id, { hostnameRoutes, ...this.connector(name, machine, args) }] as const;
      })
    );

    const workload = new ComposeWorkload(
      name,
      {
        targets: args.machines.map(machine => ({ machine, hostname: machine.hostname })),
        app: (target: WorkloadTarget) =>
          meshApp(image, target.machine.hostname, nodes.get(target.machine.id)!.token, args)
      },
      { parent: this, dependsOn: opts?.dependsOn }
    );

    this.connectors = pulumi.output(
      Object.fromEntries(
        [...nodes].map(([id, node]) => [
          id,
          pulumi.output({ id: node.id, name: node.name, status: node.status, hostnameRoutes: node.hostnameRoutes })
        ])
      )
    );
    this.registerOutputs({ connectors: this.connectors, summary: workload.summary });
  }

  private connector(name: string, machine: Machine, args: CloudflareMeshConnectorArgs) {
    const connectorName = sanitizeName(machine.hostname);
    if (args.sharedNodeToken !== undefined) {
      return {
        id: pulumi.output('external'),
        name: connectorName,
        status: pulumi.output('external-shared-token'),
        token: pulumi.secret(args.sharedNodeToken)
      };
    }
    const connector = new cloudflare.ZeroTrustTunnelWarpConnector(
      `${name}-${machine.id}`,
      { accountId: args.accountId, name: connectorName, ha: true },
      { parent: this }
    );
    const connectorToken = cloudflare.getZeroTrustTunnelWarpConnectorTokenOutput(
      { accountId: args.accountId, tunnelId: connector.id },
      { parent: this }
    );
    return {
      id: connector.id,
      name: connectorName,
      status: connector.status,
      token: pulumi.secret(connectorToken.token)
    };
  }
}

function meshApp(
  image: string,
  hostname: string,
  token: pulumi.Output<string>,
  args: CloudflareMeshConnectorArgs
): ComposeApp {
  const safetyScript = routeSafetyScript(args.routeSafetyCheck !== false);
  // Docker's restart policy and the managed unit both bring the mesh back after a reboot, when no deploy step
  // runs; hooking the check into the unit keeps a mesh that grabs the default route from cutting the host off.
  const safetyDropIn = `[Service]\nExecStartPost=${SAFETY_SCRIPT_PATH}\n`;
  return {
    name: APP,
    services: {
      [APP]: {
        image,
        container_name: APP,
        hostname,
        network_mode: 'host',
        restart: 'unless-stopped',
        pull_policy: 'always',
        cap_add: ['NET_ADMIN', 'NET_RAW'],
        devices: ['/dev/net/tun:/dev/net/tun'],
        environment: { MESH_NODE_TOKEN: token, SRCNAT_ENABLED: 'true' },
        volumes: ['meshdata:/var/lib/cloudflare-warp'],
        healthcheck: {
          test: ['CMD-SHELL', 'warp-cli status 2>/dev/null | grep -qi Connected'],
          interval: '30s',
          timeout: '5s',
          retries: 3,
          start_period: '30s'
        }
      }
    },
    volumes: { meshdata: {} },
    files: [
      { path: SAFETY_SCRIPT_PATH, content: safetyScript, mode: '0755', onChange: 'none' },
      { path: `/etc/systemd/system/${APP}.service.d/route-safety.conf`, content: safetyDropIn, onChange: 'none' }
    ],
    // `HealthCheck` only fetches URLs; connection state is only visible through `warp-cli` inside the container.
    steps: [
      {
        name: 'mesh-connected',
        script: `systemctl daemon-reload\n${SAFETY_SCRIPT_PATH}`,
        triggers: [image, hostname, token, safetyScript, safetyDropIn]
      }
    ]
  };
}

// Joined as lines: dedent cannot strip indentation around a multi-line interpolation, which would indent the shebang.
function routeSafetyScript(checkRoute: boolean): string {
  const waitForConnection = [
    '#!/bin/sh',
    'set -eu',
    'for attempt in $(seq 1 30); do',
    `  if docker exec ${APP} warp-cli status 2>/dev/null | grep -qi Connected; then`,
    '    break',
    '  fi',
    '  if [ "$attempt" -eq 30 ]; then',
    `    docker logs --tail=100 ${APP} >&2`,
    '    exit 1',
    '  fi',
    '  sleep 2',
    'done'
  ];
  const routeCheck = [
    'public_route="$(ip route get 1.1.1.1 2>/dev/null || true)"',
    `if echo "$public_route" | grep -Eiq 'dev (cloudflarewarp|warp)( |$)'; then`,
    `  docker stop ${APP} >/dev/null 2>&1 || true`,
    '  echo "Cloudflare Mesh became the host default route; stopped it to preserve direct public egress." >&2',
    '  exit 1',
    'fi'
  ];
  return [...waitForConnection, ...(checkRoute ? routeCheck : []), ''].join('\n');
}

/** Lowercased, edge dots trimmed; at most one wildcard, as the whole first label. */
export function normalizeHostnameRoute(value: string): string {
  const hostname = value
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, '');
  if (!hostname || hostname.length >= 255) throw new Error(`Invalid Cloudflare Mesh hostname route "${value}".`);
  const labels = hostname.split('.');
  const wildcards = labels.filter(label => label === '*');
  if (wildcards.length > 1 || (wildcards.length === 1 && labels[0] !== '*')) {
    throw new Error(`Cloudflare Mesh hostname route "${value}" may only use one wildcard as the first complete label.`);
  }
  const dnsLabels = wildcards.length ? labels.slice(1) : labels;
  if (dnsLabels.length < 2 || !dnsLabels.every(isDnsLabel)) {
    throw new Error(`Invalid Cloudflare Mesh hostname route "${value}".`);
  }
  return hostname;
}
