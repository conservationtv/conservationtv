import dedent from 'dedent';
import * as pulumi from '@pulumi/pulumi';
import type { PublicTlsMaterial } from '../core/certs/acme';
import { composeUnit } from '../core/host/systemd';
import { healthCheckLoop, type ComposeApp } from '../core/host/composeHost';
import type { RemoteFileSpec } from '../core/host/remote';
import { stableClusterId } from './cluster';

export const MOQ_PROMETHEUS_METRICS_PORT = 9101;
export const MOQ_HTTPS_ENDPOINT = 'moq.https';
export const MOQ_WEBTRANSPORT_ENDPOINT = 'moq.webtransport';
export const MOQ_PROMETHEUS_ENDPOINT = 'moq.prometheus';
const dir = '/opt/moq';
const publicCertPath = `${dir}/certs/public/node/fullchain.pem`;
const publicKeyPath = `${dir}/certs/public/node/privkey.pem`;
const containerPublicCertPath = '/etc/moq/certs/public/node/fullchain.pem';
const containerPublicKeyPath = '/etc/moq/certs/public/node/privkey.pem';
export const MOQ_RELAY_IMAGE = 'moqdev/moq-relay:0.17.2';

export interface MoqRelayAppArgs {
  nodeId: string;
  hostname: string;
  image?: string;
  authOrigin: string;
  /** Shared key the relay presents on its admission callbacks. */
  authToken: pulumi.Input<string>;
  peers: string[];
  clusterToken: pulumi.Input<string>;
  publicTls: PublicTlsMaterial;
}

/** The admission callback URL, carrying `authToken` as userinfo so moq-relay sends it as HTTP Basic credentials. */
export function moqAuthUrl(authOrigin: string, authToken: string): string {
  const url = new URL('/relays/moq/admission', authOrigin);
  url.username = 'moq-relay';
  url.password = authToken;
  return url.toString();
}

export function moqRelayApp(args: MoqRelayAppArgs): ComposeApp {
  const relayToml = renderMoqRelayToml(args.nodeId, args.hostname, args.peers);
  // Passed through the 0600 compose file rather than relay.toml, which is world-readable and not secret.
  const authUrl = pulumi.secret(args.authToken).apply(token => {
    if (!token.trim() || /[\r\n]/.test(token)) throw new Error('MoQ authToken must be a non-empty single-line key');
    return moqAuthUrl(args.authOrigin, token);
  });
  const clusterToken = pulumi.secret(args.clusterToken).apply(value => {
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('MoQ clusterToken must be 32 bytes encoded as lowercase hex');
    return value;
  });
  const relayService = {
    image: args.image ?? MOQ_RELAY_IMAGE,
    restart: 'unless-stopped',
    network_mode: 'host',
    pull_policy: 'always',
    ulimits: { nofile: { soft: 65536, hard: 65536 } },
    environment: { MOQ_AUTH_URL: authUrl },
    volumes: [
      `${dir}/relay.toml:/etc/moq/relay.toml:ro`,
      `${dir}/certs:/etc/moq/certs:ro`,
      `${dir}/secrets:/etc/moq/secrets:ro`
    ],
    command: ['/etc/moq/relay.toml']
  };
  const files: RemoteFileSpec[] = [
    { path: `${dir}/relay.toml`, content: relayToml, permissions: '0644' },
    { path: publicCertPath, content: args.publicTls.fullchainPem, permissions: '0644' },
    { path: publicKeyPath, content: args.publicTls.privateKeyPem, permissions: '0600' },
    { path: `${dir}/secrets/cluster-token`, content: clusterToken, permissions: '0600' }
  ];

  const health = healthCheckLoop({
    url: `http://127.0.0.1:${MOQ_PROMETHEUS_METRICS_PORT}/health`,
    expectGrep: { url: `http://127.0.0.1:${MOQ_PROMETHEUS_METRICS_PORT}/metrics`, pattern: '^# HELP moq_relay_' },
    logsOnFailure: 'docker compose -f {{composeFile}} logs --tail=100 relay'
  });
  return {
    name: 'moq',
    dir,
    services: { relay: relayService },
    endpoints: {
      [MOQ_HTTPS_ENDPOINT]: {
        service: 'relay',
        port: 443,
        transport: 'tcp',
        visibility: 'public',
        scheme: 'https',
        paths: { health: '/health' },
        description: 'MoQ HTTPS relay endpoint'
      },
      [MOQ_WEBTRANSPORT_ENDPOINT]: {
        service: 'relay',
        port: 443,
        transport: 'udp',
        visibility: 'public',
        scheme: 'https',
        description: 'MoQ WebTransport endpoint'
      },
      [MOQ_PROMETHEUS_ENDPOINT]: {
        service: 'relay',
        port: MOQ_PROMETHEUS_METRICS_PORT,
        transport: 'tcp',
        visibility: 'private',
        scheme: 'http',
        paths: { health: '/health', metrics: '/metrics' },
        description: 'MoQ Prometheus metrics and internal health endpoint'
      }
    },
    files,
    systemdUnits: [{ path: '/etc/systemd/system/moq.service', content: composeUnit('MoQ relay', dir, ['relay']) }],
    deploySteps: [
      {
        name: 'deploy-relay',
        script: dedent`
          systemctl daemon-reload
          systemctl enable moq.service
          docker compose -f {{composeFile}} pull relay
          docker compose -f {{composeFile}} up -d --force-recreate --remove-orphans relay
          ${health}
        `,
        triggers: [args.image ?? MOQ_RELAY_IMAGE, relayToml, clusterToken, authUrl]
      },
      {
        name: 'refresh-relay-certs',
        script: dedent`
          docker compose -f {{composeFile}} restart relay
          ${health}
        `,
        triggers: [args.publicTls.fullchainPem, args.publicTls.privateKeyPem],
        dependsOnSteps: ['deploy-relay']
      }
    ],
    healthUrl: `https://${args.hostname}/health`
  };
}

export function renderMoqRelayToml(nodeId: string, hostname: string, peers: string[]): string {
  return `[listen]
bind = "[::]:443"

[listen.tls]
cert = ${tomlString(containerPublicCertPath)}
key = ${tomlString(containerPublicKeyPath)}

[web.https]
listen = "[::]:443"
cert = ${tomlString(containerPublicCertPath)}
key = ${tomlString(containerPublicKeyPath)}

[cluster]
id = ${stableClusterId(nodeId)}
node = ${tomlString(`https://${hostname}/`)}
connect = ${JSON.stringify(peers)}
token = "/etc/moq/secrets/cluster-token"

[stats]
enabled = true
node = ${tomlString(nodeId)}

[internal]
listen = "127.0.0.1:${MOQ_PROMETHEUS_METRICS_PORT}"
`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
