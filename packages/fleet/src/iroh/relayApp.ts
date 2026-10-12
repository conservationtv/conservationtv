import * as pulumi from '@pulumi/pulumi';
import dedent from 'dedent';
import type { PublicTlsMaterial } from '../core/certs/acme';
import { readHttpsUrl } from '../core/config';
import { healthCheckLoop, type ComposeApp } from '../core/host/composeHost';
import { composeUnit } from '../core/host/systemd';

const dir = '/opt/iroh';
const publicCertPath = `${dir}/certs/fullchain.pem`;
const publicKeyPath = `${dir}/certs/privkey.pem`;
const containerPublicCertPath = '/etc/iroh/certs/fullchain.pem';
const containerPublicKeyPath = '/etc/iroh/certs/privkey.pem';

export const IROH_HTTPS_ENDPOINT = 'iroh.https';
export const IROH_QUIC_DISCOVERY_ENDPOINT = 'iroh.quic-discovery';
export const IROH_METRICS_ENDPOINT = 'iroh.metrics';
export const IROH_HTTP_ENDPOINT = 'iroh.http';
export const IROH_RELAY_IMAGE =
  'n0computer/iroh-relay:v1.3.0@sha256:7a51e3826531dba5eee73d8b48a8f27284684d98c4d0da271d99127cc43b9d57';

export interface IrohRelayPorts {
  https: number;
  quicDiscovery: number;
  metrics: number;
  http: number;
}

export interface IrohRelayAppArgs {
  hostname: string;
  image?: string;
  /** Gatekeeper's HTTPS /relays/iroh/admission endpoint. */
  admissionUrl: string;
  /** Must match gatekeeper's IROH_RELAY_TOKEN binding; never distributed to clients. */
  admissionToken: pulumi.Input<string>;
  publicTls: PublicTlsMaterial;
  ports?: Partial<IrohRelayPorts>;
}

export function irohRelayApp(args: IrohRelayAppArgs): ComposeApp {
  const ports = readIrohRelayPorts(args.ports);
  const config = renderIrohRelayToml(readHttpsUrl(args.admissionUrl, 'Iroh admission URL'), ports);
  const image = args.image ?? IROH_RELAY_IMAGE;
  const admissionToken = pulumi.secret(args.admissionToken).apply(token => {
    if (!token.trim() || /[\r\n]/.test(token))
      throw new Error('Iroh admission token must be a non-empty bearer token.');
    return token;
  });
  const service = {
    image,
    restart: 'unless-stopped',
    network_mode: 'host',
    pull_policy: 'always',
    environment: {
      IROH_RELAY_HTTP_BEARER_TOKEN: admissionToken,
      RUST_LOG: 'iroh_relay=info'
    },
    volumes: [`${dir}/iroh-relay.toml:/etc/iroh/iroh-relay.toml:ro`, `${dir}/certs:/etc/iroh/certs:ro`],
    command: ['--config-path', '/etc/iroh/iroh-relay.toml']
  };
  const health = healthCheckLoop({
    url: `http://127.0.0.1:${ports.metrics}/metrics`,
    logsOnFailure: 'docker compose -f {{composeFile}} logs --tail=100 relay'
  });
  return {
    name: 'iroh',
    dir,
    services: { relay: service },
    endpoints: {
      [IROH_HTTPS_ENDPOINT]: {
        service: 'relay',
        port: ports.https,
        transport: 'tcp',
        visibility: 'public',
        scheme: 'https',
        description: 'Iroh HTTPS relay endpoint'
      },
      [IROH_QUIC_DISCOVERY_ENDPOINT]: {
        service: 'relay',
        port: ports.quicDiscovery,
        transport: 'udp',
        visibility: 'public',
        description: 'Iroh QUIC address discovery endpoint'
      },
      [IROH_METRICS_ENDPOINT]: {
        service: 'relay',
        port: ports.metrics,
        transport: 'tcp',
        visibility: 'private',
        scheme: 'http',
        paths: { metrics: '/metrics' },
        description: 'Iroh metrics endpoint'
      },
      [IROH_HTTP_ENDPOINT]: {
        service: 'relay',
        port: ports.http,
        transport: 'tcp',
        visibility: 'loopback',
        scheme: 'http',
        description: 'Iroh internal HTTP listener'
      }
    },
    files: [
      { path: `${dir}/iroh-relay.toml`, content: config, permissions: '0644' },
      { path: publicCertPath, content: args.publicTls.fullchainPem, permissions: '0644' },
      { path: publicKeyPath, content: args.publicTls.privateKeyPem, permissions: '0600' }
    ],
    systemdUnits: [{ path: '/etc/systemd/system/iroh.service', content: composeUnit('Iroh relay', dir, ['relay']) }],
    deploySteps: [
      {
        name: 'deploy-relay',
        script: dedent`
          systemctl daemon-reload
          systemctl enable iroh.service
          docker compose -f {{composeFile}} pull relay
          docker compose -f {{composeFile}} up -d --force-recreate --remove-orphans relay
          ${health}
        `,
        triggers: [image, config, admissionToken]
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
    healthUrl: `https://${args.hostname}${ports.https === 443 ? '' : `:${ports.https}`}`
  };
}

/** Render the relay config without credentials. HTTP is supported here for local development; fleet requires HTTPS. */
export function renderIrohRelayToml(admissionUrl: string, portOverrides: Partial<IrohRelayPorts> = {}): string {
  const url = new URL(admissionUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('Iroh admission URL must use HTTP(S) without credentials or a fragment.');
  }
  const ports = readIrohRelayPorts(portOverrides);
  return `enable_relay = true
http_bind_addr = "127.0.0.1:${ports.http}"
enable_quic_addr_discovery = true
enable_metrics = true
metrics_bind_addr = "[::]:${ports.metrics}"

[access.http]
url = ${JSON.stringify(url.toString())}

[tls]
cert_mode = "Manual"
manual_cert_path = ${JSON.stringify(containerPublicCertPath)}
manual_key_path = ${JSON.stringify(containerPublicKeyPath)}
https_bind_addr = "[::]:${ports.https}"
quic_bind_addr = "[::]:${ports.quicDiscovery}"
`;
}

export function readIrohRelayPorts(overrides: Partial<IrohRelayPorts> = {}): IrohRelayPorts {
  const ports: IrohRelayPorts = {
    https: readIrohRelayPort('https', overrides.https, 443),
    quicDiscovery: readIrohRelayPort('quicDiscovery', overrides.quicDiscovery, 7842),
    metrics: readIrohRelayPort('metrics', overrides.metrics, 9090),
    http: readIrohRelayPort('http', overrides.http, 8080)
  };
  validateDistinctIrohTcpPorts(ports);
  return ports;
}

// Use the default unless overridden, then require an integer in the valid port range.
function readIrohRelayPort(name: string, override: number | undefined, defaultPort: number): number {
  const port = override ?? defaultPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Iroh ${name} port must be an integer from 1 to 65535.`);
  }
  return port;
}

function validateDistinctIrohTcpPorts(ports: IrohRelayPorts): void {
  if (new Set([ports.https, ports.metrics, ports.http]).size !== 3) {
    throw new Error('Iroh HTTPS, metrics, and HTTP TCP ports must be distinct.');
  }
}
