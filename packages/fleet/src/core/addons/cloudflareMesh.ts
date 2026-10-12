import * as cloudflare from '@pulumi/cloudflare';
import * as pulumi from '@pulumi/pulumi';
import dedent from 'dedent';
import { resourceName } from '../naming';
import { preflightCloudflare, type PreflightOptions } from '../preflight';
import { Addon, type AddonAttachmentContext, type HostAddonContribution } from './types';

export const DEFAULT_CLOUDFLARE_MESH_IMAGE =
  'docker.io/cloudflare/mesh:2026.7.0@sha256:18fad6d500e8ca48b7e4d5ae1905d65e8a50c1f5f5e21eba020d54d5cbf82571';

interface CloudflareConfig {
  accountId: pulumi.Input<string>;
}

export interface CloudflareMeshAddonArgs {
  cloudflare: CloudflareConfig;
  image?: string;
  sharedNodeToken?: pulumi.Input<string>;
  hostnameRoutes?: (context: AddonAttachmentContext) => string[];
  routeSafetyCheck?: boolean;
  preflight?: PreflightOptions;
}

export interface CloudflareMeshContribution extends HostAddonContribution {
  nodeId?: pulumi.Output<string>;
  nodeToken: pulumi.Output<string>;
  nodeStatus: pulumi.Output<string>;
}

export class CloudflareMeshAddon extends Addon {
  private readonly args: CloudflareMeshAddonArgs;

  public constructor(name: string, args: CloudflareMeshAddonArgs, opts?: pulumi.ComponentResourceOptions) {
    super('fleet:core:CloudflareMeshAddon', name, opts, 'node');
    if (args.preflight) preflightCloudflare(args.preflight);
    this.args = args;
    this.registerOutputs({});
  }

  private resolveConnector(context: AddonAttachmentContext, nodeName: string) {
    const args = this.args;
    if (args.sharedNodeToken !== undefined) {
      return {
        nodeId: undefined,
        nodeStatus: pulumi.output('external-shared-token'),
        token: pulumi.secret(args.sharedNodeToken)
      };
    }
    const connector = new cloudflare.ZeroTrustTunnelWarpConnector(
      `${context.node.machineName}-connector`,
      {
        accountId: args.cloudflare.accountId,
        name: nodeName,
        ha: true
      },
      { parent: this }
    );
    const connectorToken = cloudflare.getZeroTrustTunnelWarpConnectorTokenOutput(
      {
        accountId: args.cloudflare.accountId,
        tunnelId: connector.id
      },
      { parent: this }
    );
    return {
      nodeId: connector.id,
      nodeStatus: connector.status,
      token: pulumi.secret(connectorToken.token)
    };
  }

  // Use a shared token or provision a connector, then render the mesh service with optional route protection.
  public attachTo(context: AddonAttachmentContext): CloudflareMeshContribution {
    const args = this.args;
    const nodeName = resourceName(context.fleet.namePrefix, context.fleet.environment, context.hostname);
    const { nodeId, nodeStatus, token } = this.resolveConnector(context, nodeName);

    const requestedRoutes = [...new Set((args.hostnameRoutes?.(context) ?? []).map(normalizeHostnameRoute))];
    if (requestedRoutes.length > 0) {
      pulumi.log.warn(
        `Cloudflare hostname routes (${requestedRoutes.join(', ')}) are declared but @pulumi/cloudflare does not expose the 2026 hostname-route resource yet; create them through the Cloudflare dashboard/API.`,
        this
      );
    }

    const image = args.image ?? DEFAULT_CLOUDFLARE_MESH_IMAGE;
    const serviceName = 'cloudflare-mesh';
    const safetyScriptPath = '/usr/local/sbin/fleet-cloudflare-mesh-safety';
    const safetyCheck =
      args.routeSafetyCheck === false
        ? ''
        : dedent`
      public_route="$(ip route get 1.1.1.1 2>/dev/null || true)"
      if echo "$public_route" | grep -Eiq 'dev (cloudflarewarp|warp)( |$)'; then
        docker stop ${serviceName} >/dev/null 2>&1 || true
        echo "Cloudflare Mesh became the host default route; stopped it to preserve direct public egress." >&2
        exit 1
      fi
    `;
    const safetyScript = dedent`
      #!/bin/sh
      set -eu
      for attempt in $(seq 1 30); do
        if docker exec ${serviceName} warp-cli status 2>/dev/null | grep -qi Connected; then
          break
        fi
        if [ "$attempt" -eq 30 ]; then
          docker compose -f {{composeFile}} logs --tail=100 ${serviceName}
          exit 1
        fi
        sleep 2
      done
      ${safetyCheck}
    `;
    const unit = dedent`
      [Unit]
      Description=Cloudflare Mesh container
      After=docker.service network-online.target
      Wants=network-online.target
      Requires=docker.service

      [Service]
      Type=oneshot
      RemainAfterExit=yes
      ExecStartPre=/usr/bin/docker compose -f {{composeFile}} pull ${serviceName}
      ExecStart=/usr/bin/docker compose -f {{composeFile}} up -d --force-recreate --no-deps ${serviceName}
      ExecStartPost=${safetyScriptPath}
      ExecStop=/usr/bin/docker compose -f {{composeFile}} stop ${serviceName}
      TimeoutStartSec=0

      [Install]
      WantedBy=multi-user.target
    `;
    const deployScript = dedent`
      systemctl daemon-reload
      systemctl enable cloudflare-mesh.service
      systemctl restart cloudflare-mesh.service
    `;

    return {
      name: 'cloudflare-mesh',
      services: {
        [serviceName]: {
          image,
          container_name: serviceName,
          hostname: context.hostname,
          network_mode: 'host',
          restart: 'unless-stopped',
          pull_policy: 'always',
          cap_add: ['NET_ADMIN', 'NET_RAW'],
          devices: ['/dev/net/tun:/dev/net/tun'],
          environment: {
            MESH_NODE_TOKEN: token,
            SRCNAT_ENABLED: 'true'
          },
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
      files: [{ path: safetyScriptPath, content: safetyScript, permissions: '0755' }],
      systemdUnits: [{ path: '/etc/systemd/system/cloudflare-mesh.service', content: unit }],
      deploySteps: [
        { name: 'deploy-cloudflare-mesh', script: deployScript, triggers: [image, token, safetyScript, unit] }
      ],
      summary: {
        nodeId: nodeId ?? 'external',
        nodeName,
        nodeStatus,
        hostnameRoutes: requestedRoutes.join(',')
      },
      nodeId,
      nodeToken: token,
      nodeStatus
    };
  }
}

// Normalize case and edge dots, then validate DNS labels and allow only one leading wildcard.
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
  if (dnsLabels.length < 2 || !dnsLabels.every(label => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new Error(`Invalid Cloudflare Mesh hostname route "${value}".`);
  }
  return hostname;
}
